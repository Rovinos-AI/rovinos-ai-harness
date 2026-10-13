// SPDX-License-Identifier: Apache-2.0
// Every evaluation includes all matches so callers can choose when to show explain output.
import { Code, JsonPointerSchema, JsonValue, parseTokenType } from "@harness/schemas";
import type { Code as CodeValue, JsonPointer, JsonValue as JsonValueType } from "@harness/schemas";
import { z } from "zod";
import { PolicyDocumentSchema } from "./schema.js";
import type { ArgMatcher, PolicyDocument, Rule } from "./schema.js";

const DecisionSchema = z.enum(["allow", "ask", "deny"]);

const PolicyCallContextSchema = z
  .object({
    subagent: z.boolean(),
    server: Code.optional(),
    app: Code.optional(),
  })
  .strict();

/** Schema for a tool call evaluated against tokenized arguments and policy context. */
export const PolicyCallSchema = z
  .object({
    toolId: Code,
    args: JsonValue,
    context: PolicyCallContextSchema,
  })
  .strict();

/**
 * A policy evaluation input. `subagent` is always known; `server` is omitted
 * for calls that are not from an MCP tool.
 */
export type PolicyCall = z.infer<typeof PolicyCallSchema>;

const MatchedRuleSchema = z
  .object({
    ruleId: Code,
    decision: DecisionSchema,
  })
  .strict();

/** Explanation of a policy decision, including every matching rule in document order. */
export const ExplanationSchema = z
  .object({
    decision: DecisionSchema,
    ruleId: Code.or(z.literal("default")),
    reason: Code,
    matched: z.array(MatchedRuleSchema),
    editable: z.array(JsonPointerSchema),
    approvalTtlMs: z.number().int().positive().optional(),
    escalateAfterMs: z.number().int().positive().optional(),
  })
  .strict();

/** Inferred explanation returned by {@link evaluate}. */
export type Explanation = z.infer<typeof ExplanationSchema>;

type PointerLookup =
  { readonly exists: true; readonly value: JsonValueType } | { readonly exists: false };

interface CompiledMatcher {
  readonly matcher: ArgMatcher;
  readonly pattern?: RegExp;
}

interface CompiledRule {
  readonly rule: Rule;
  readonly matchers: readonly CompiledMatcher[];
}

function pointerValue(root: JsonValueType, pointer: JsonPointer): PointerLookup {
  let current = root;
  const segments = pointer === "" ? [] : pointer.slice(1).split("/");

  for (const segment of segments) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(key)) {
        return { exists: false };
      }
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        return { exists: false };
      }
      const next = current[index];
      if (next === undefined) {
        return { exists: false };
      }
      current = next;
    } else if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, key)) {
        return { exists: false };
      }
      const next = current[key];
      if (next === undefined) {
        return { exists: false };
      }
      current = next;
    } else {
      return { exists: false };
    }
  }

  return { exists: true, value: current };
}

function jsonEquals(left: JsonValueType, right: JsonValueType): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => {
      const other = right[index];
      return other !== undefined && jsonEquals(value, other);
    });
  }

  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) {
    return false;
  }
  return keys.every((key) => {
    if (!Object.hasOwn(right, key)) {
      return false;
    }
    const value = left[key];
    const other = right[key];
    return value !== undefined && other !== undefined && jsonEquals(value, other);
  });
}

function matchesStringPrefix(candidate: JsonValueType, expected: JsonValueType): boolean {
  return (
    typeof candidate === "string" && typeof expected === "string" && candidate.startsWith(expected)
  );
}

function matchesTokenType(candidate: JsonValueType, expected: JsonValueType): boolean {
  if (typeof candidate !== "string" || typeof expected !== "string") {
    return false;
  }
  return parseTokenType(candidate)?.toLowerCase() === expected;
}

function matchesMatcherValue(
  candidate: JsonValueType,
  matcher: ArgMatcher,
  pattern?: RegExp,
): boolean {
  if (matcher.value === undefined) {
    return false;
  }
  switch (matcher.op) {
    case "equals":
      return jsonEquals(candidate, matcher.value);
    case "in":
      return (
        Array.isArray(matcher.value) && matcher.value.some((value) => jsonEquals(candidate, value))
      );
    case "startsWith":
      return matchesStringPrefix(candidate, matcher.value);
    case "matches":
      return typeof candidate === "string" && pattern?.test(candidate) === true;
    case "tokenType":
      return matchesTokenType(candidate, matcher.value);
    case "exists":
      return false;
  }
}

function matchesArgument(args: JsonValueType, { matcher, pattern }: CompiledMatcher): boolean {
  const lookup = pointerValue(args, matcher.pointer);
  if (matcher.op === "exists") {
    return lookup.exists;
  }
  if (!lookup.exists) {
    return false;
  }
  return matchesMatcherValue(lookup.value, matcher, pattern);
}

function matchesTool(patterns: Rule["match"]["tools"], toolId: CodeValue): boolean {
  if (patterns === "*") {
    return true;
  }
  return patterns.some((pattern) =>
    pattern.endsWith(".*") ? toolId.startsWith(`${pattern.slice(0, -2)}.`) : pattern === toolId,
  );
}

function matchesContext(
  ruleContext: Rule["match"]["context"],
  callContext: PolicyCall["context"],
): boolean {
  return (
    ruleContext === undefined ||
    ((ruleContext.subagent === undefined || ruleContext.subagent === callContext.subagent) &&
      (ruleContext.server === undefined || ruleContext.server === callContext.server) &&
      (ruleContext.app === undefined || ruleContext.app === callContext.app))
  );
}

function matchesRule({ rule, matchers }: CompiledRule, call: PolicyCall): boolean {
  return (
    matchesTool(rule.match.tools, call.toolId) &&
    matchers.every((matcher) => matchesArgument(call.args, matcher)) &&
    matchesContext(rule.match.context, call.context)
  );
}

const DECISION_RANK: Record<Rule["decision"], number> = { allow: 0, ask: 1, deny: 2 };

function toExplanation(rule: Rule, matched: Explanation["matched"]): Explanation {
  return ExplanationSchema.parse({
    decision: rule.decision,
    ruleId: rule.id,
    reason: rule.reason,
    matched,
    editable: rule.editable === undefined ? [] : [...rule.editable],
    ...(rule.approvalTtlMs === undefined ? {} : { approvalTtlMs: rule.approvalTtlMs }),
    ...(rule.escalateAfterMs === undefined ? {} : { escalateAfterMs: rule.escalateAfterMs }),
  });
}

/** Reusable evaluator for a document validated and compiled by {@link compilePolicy}. */
export interface CompiledPolicy {
  /**
   * Evaluates a tool call without parsing the policy document again.
   *
   * @param call - The tool id, tokenized JSON arguments, and policy context.
   * @returns The deterministic decision and its explanation.
   * @throws {z.ZodError} If the call is invalid.
   */
  evaluate(call: PolicyCall): Explanation;
}

/**
 * Validates and compiles a policy once for repeated tool-call evaluation.
 *
 * The most restrictive matching decision wins (`deny` > `ask` > `allow`); ties
 * use the first matching rule in document order. All matches are returned in
 * `matched`, also in document order.
 *
 * @param doc - A policy document.
 * @returns A reusable evaluator with precompiled argument patterns.
 * @throws {z.ZodError} If the document is invalid.
 */
export function compilePolicy(doc: PolicyDocument): CompiledPolicy {
  const document = PolicyDocumentSchema.parse(doc);
  const rules: CompiledRule[] = document.rules.map((rule) => ({
    rule,
    matchers: (rule.match.args ?? []).map((matcher) =>
      matcher.op === "matches" && typeof matcher.value === "string"
        ? { matcher, pattern: new RegExp(matcher.value, "u") }
        : { matcher },
    ),
  }));

  return {
    evaluate(call) {
      const validatedCall = PolicyCallSchema.parse(call);
      const matchingRules = rules.filter((rule) => matchesRule(rule, validatedCall));
      const matched = matchingRules.map(({ rule }) => ({
        ruleId: rule.id,
        decision: rule.decision,
      }));

      if (matchingRules.length === 0) {
        return ExplanationSchema.parse({
          decision: document.defaultDecision,
          ruleId: "default",
          reason: "default_decision",
          matched,
          editable: [],
        });
      }

      const selectedRule = matchingRules.reduce((selected, candidate) =>
        DECISION_RANK[candidate.rule.decision] > DECISION_RANK[selected.rule.decision]
          ? candidate
          : selected,
      );
      return toExplanation(selectedRule.rule, matched);
    },
  };
}

/**
 * Evaluates a tokenized tool call against a policy document.
 *
 * The most restrictive matching decision wins (`deny` > `ask` > `allow`); ties
 * use the first matching rule in document order. All matches are returned in
 * `matched`, also in document order. For repeated evaluations, use
 * {@link compilePolicy} to validate the document and compile patterns once.
 *
 * @param doc - A policy document.
 * @param call - The tool id, tokenized JSON arguments, and policy context.
 * @returns The deterministic decision and its explanation.
 * @throws {z.ZodError} If the document or call is invalid.
 */
export function evaluate(doc: PolicyDocument, call: PolicyCall): Explanation {
  return compilePolicy(doc).evaluate(call);
}
