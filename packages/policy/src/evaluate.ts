// SPDX-License-Identifier: Apache-2.0
// Every evaluation includes all matches so callers can choose when to show explain output.
import { Code, JsonPointerSchema, JsonValue, TOKEN_TYPE_MAX_LENGTH } from "@harness/schemas";
import type { Code as CodeValue, JsonPointer, JsonValue as JsonValueType } from "@harness/schemas";
import { z } from "zod";
import { PolicyDocumentSchema } from "./schema.js";
import type { ArgMatcher, PolicyDocument, Rule } from "./schema.js";

const DecisionSchema = z.enum(["allow", "ask", "deny"]);

const PolicyCallContextSchema = z
  .object({
    subagent: z.boolean().optional(),
    server: Code.optional(),
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

/** A policy evaluation input. */
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

const TOKEN_TYPE_PATTERN = new RegExp(
  `^<[A-Z][A-Z0-9_]{0,${String(TOKEN_TYPE_MAX_LENGTH - 1)}}_[1-9]\\d{0,5}>$`,
  "u",
);

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

function matchesPattern(candidate: JsonValueType, expected: JsonValueType): boolean {
  return (
    typeof candidate === "string" &&
    typeof expected === "string" &&
    new RegExp(expected, "u").test(candidate)
  );
}

function matchesTokenType(candidate: JsonValueType, expected: JsonValueType): boolean {
  if (typeof candidate !== "string" || typeof expected !== "string") {
    return false;
  }
  const token = TOKEN_TYPE_PATTERN.exec(candidate);
  return token !== null && token[0].slice(1, token[0].lastIndexOf("_")).toLowerCase() === expected;
}

function matchesMatcherValue(candidate: JsonValueType, matcher: ArgMatcher): boolean {
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
      return matchesPattern(candidate, matcher.value);
    case "tokenType":
      return matchesTokenType(candidate, matcher.value);
    case "exists":
      return false;
  }
}

function matchesArgument(args: JsonValueType, matcher: ArgMatcher): boolean {
  const lookup = pointerValue(args, matcher.pointer);
  if (matcher.op === "exists") {
    return lookup.exists;
  }
  if (!lookup.exists) {
    return false;
  }
  return matchesMatcherValue(lookup.value, matcher);
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
      (ruleContext.server === undefined || ruleContext.server === callContext.server))
  );
}

function matchesRule(rule: Rule, call: PolicyCall): boolean {
  return (
    matchesTool(rule.match.tools, call.toolId) &&
    (rule.match.args ?? []).every((matcher) => matchesArgument(call.args, matcher)) &&
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

/**
 * Evaluates a tokenized tool call against a validated policy document.
 *
 * The most restrictive matching decision wins (`deny` > `ask` > `allow`); ties
 * use the first matching rule in document order. All matches are returned in
 * `matched`, also in document order.
 *
 * @param doc - A policy document.
 * @param call - The tool id, tokenized JSON arguments, and policy context.
 * @returns The deterministic decision and its explanation.
 */
export function evaluate(doc: PolicyDocument, call: PolicyCall): Explanation {
  const document = PolicyDocumentSchema.parse(doc);
  const validatedCall = PolicyCallSchema.parse(call);
  const matchingRules = document.rules.filter((rule) => matchesRule(rule, validatedCall));
  const matched = matchingRules.map(({ id, decision }) => ({ ruleId: id, decision }));

  if (matchingRules.length === 0) {
    return ExplanationSchema.parse({
      decision: document.defaultDecision,
      ruleId: "default",
      reason: "default_decision",
      matched,
      editable: [],
    });
  }

  const selectedRule = matchingRules.reduce((selected, rule) =>
    DECISION_RANK[rule.decision] > DECISION_RANK[selected.decision] ? rule : selected,
  );
  return toExplanation(selectedRule, matched);
}
