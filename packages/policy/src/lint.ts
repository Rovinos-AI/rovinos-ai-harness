// SPDX-License-Identifier: Apache-2.0
import { Code, JsonValue, PolicyLintResultSchema, parseTokenType } from "@harness/schemas";
import type { JsonValue as JsonValueType, PolicyLintResult } from "@harness/schemas";
import { PolicyDocumentSchema } from "./schema.js";
import type { ArgMatcher, Rule } from "./schema.js";
import { z } from "zod";

const LintToolMetadataSchema = z.array(
  z
    .object({
      toolId: Code,
      destructive: z.boolean().optional(),
      inputSchema: JsonValue.optional(),
    })
    .strict(),
);

type LintToolMetadata = z.infer<typeof LintToolMetadataSchema>;
type Decision = Rule["decision"];
const UnknownArraySchema = z.array(z.unknown());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ruleIdAt(value: unknown, index: number): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.rules)) {
    return undefined;
  }
  const rules = UnknownArraySchema.safeParse(value.rules);
  if (!rules.success) {
    return undefined;
  }
  const rule = rules.data[index];
  if (!isRecord(rule)) {
    return undefined;
  }
  const result = Code.safeParse(rule.id);
  return result.success ? result.data : undefined;
}

function hasMissingReason(value: unknown, index: number): boolean {
  if (!isRecord(value) || !Array.isArray(value.rules)) {
    return false;
  }
  const rules = UnknownArraySchema.safeParse(value.rules);
  if (!rules.success) {
    return false;
  }
  const rule = rules.data[index];
  return isRecord(rule) && !Object.hasOwn(rule, "reason");
}

function diagnostic(
  severity: "error" | "warning",
  code: string,
  ruleId?: string,
): PolicyLintResult["diagnostics"][number] {
  return {
    severity,
    code,
    ...(ruleId === undefined ? {} : { ruleId }),
  };
}

function invalidDocumentDiagnostics(
  value: unknown,
  issues: z.ZodError["issues"],
): PolicyLintResult {
  const diagnostics = issues.flatMap((issue) => {
    for (let position = 0; position < issue.path.length - 2; position += 1) {
      const index = issue.path[position + 1];
      if (
        issue.path[position] === "rules" &&
        typeof index === "number" &&
        issue.path[position + 2] === "reason" &&
        hasMissingReason(value, index)
      ) {
        return [diagnostic("error", "missing_reason", ruleIdAt(value, index))];
      }
    }
    return [];
  });
  diagnostics.push(diagnostic("error", "policy_invalid"));
  return PolicyLintResultSchema.parse({ diagnostics });
}

function decisionRank(decision: Decision): number {
  switch (decision) {
    case "allow":
      return 0;
    case "ask":
      return 1;
    case "deny":
      return 2;
  }
}

function patternContains(cover: string, candidate: string): boolean {
  if (cover === "*") {
    return true;
  }
  if (candidate === "*") {
    return false;
  }
  if (cover.endsWith(".*")) {
    const prefix = cover.slice(0, -1);
    return candidate === cover || candidate.startsWith(prefix);
  }
  return candidate === cover;
}

function toolsAreSubset(candidate: Rule["match"]["tools"], cover: Rule["match"]["tools"]): boolean {
  const candidates = candidate === "*" ? ["*"] : candidate;
  const covers = cover === "*" ? ["*"] : cover;
  return candidates.every((candidatePattern) =>
    covers.some((coverPattern) => patternContains(coverPattern, candidatePattern)),
  );
}

function contextsAreSubset(
  candidate: Rule["match"]["context"],
  cover: Rule["match"]["context"],
): boolean {
  if (cover === undefined) {
    return true;
  }
  return (
    (cover.subagent === undefined || candidate?.subagent === cover.subagent) &&
    (cover.server === undefined || candidate?.server === cover.server) &&
    (cover.app === undefined || candidate?.app === cover.app)
  );
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
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      const value = left[key];
      const other = right[key];
      return (
        Object.hasOwn(right, key) &&
        value !== undefined &&
        other !== undefined &&
        jsonEquals(value, other)
      );
    })
  );
}

function exactValues(matcher: ArgMatcher): JsonValueType[] | undefined {
  if (matcher.op === "equals" && matcher.value !== undefined) {
    return [matcher.value];
  }
  if (matcher.op === "in" && Array.isArray(matcher.value)) {
    return matcher.value;
  }
  return undefined;
}

function valuesImplyMatcher(
  values: readonly JsonValueType[],
  cover: ArgMatcher & { readonly value: JsonValueType },
): boolean {
  switch (cover.op) {
    case "equals":
      return values.length === 1 && jsonEquals(values[0] ?? null, cover.value);
    case "in":
      const allowedValues = cover.value;
      if (!Array.isArray(allowedValues)) {
        return false;
      }
      return values.every((value) => allowedValues.some((allowed) => jsonEquals(value, allowed)));
    case "startsWith": {
      const prefix = cover.value;
      if (typeof prefix !== "string") {
        return false;
      }
      return values.every((value) => typeof value === "string" && value.startsWith(prefix));
    }
    case "matches": {
      const expression = cover.value;
      if (typeof expression !== "string") {
        return false;
      }
      const pattern = new RegExp(expression, "u");
      return values.every((value) => typeof value === "string" && pattern.test(value));
    }
    case "tokenType":
      return (
        typeof cover.value === "string" &&
        values.every(
          (value) =>
            typeof value === "string" && parseTokenType(value)?.toLowerCase() === cover.value,
        )
      );
    case "exists":
      return true;
  }
}

function matcherImplies(candidate: ArgMatcher, cover: ArgMatcher): boolean {
  if (candidate.pointer !== cover.pointer) {
    return false;
  }
  if (cover.op === "exists") {
    return true;
  }
  if (candidate.op === cover.op && jsonEquals(candidate.value ?? null, cover.value ?? null)) {
    return true;
  }
  const values = exactValues(candidate);
  const coverValue = cover.value;
  return (
    values !== undefined &&
    coverValue !== undefined &&
    valuesImplyMatcher(values, { ...cover, value: coverValue })
  );
}

function argsAreSubset(candidate: Rule, cover: Rule): boolean {
  const coverMatchers = cover.match.args ?? [];
  const candidateMatchers = candidate.match.args ?? [];
  return coverMatchers.every((coverMatcher) =>
    candidateMatchers.some((candidateMatcher) => matcherImplies(candidateMatcher, coverMatcher)),
  );
}

function ruleIsSubset(candidate: Rule, cover: Rule): boolean {
  return (
    toolsAreSubset(candidate.match.tools, cover.match.tools) &&
    argsAreSubset(candidate, cover) &&
    contextsAreSubset(candidate.match.context, cover.match.context)
  );
}

function canonicalJson(value: JsonValueType): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

function matcherKey(rule: Rule): string {
  const tools = rule.match.tools === "*" ? "*" : [...rule.match.tools].sort();
  const args = (rule.match.args ?? [])
    .map(
      (matcher) =>
        `${matcher.pointer}:${matcher.op}:${matcher.value === undefined ? "" : canonicalJson(matcher.value)}`,
    )
    .sort();
  return JSON.stringify({ tools, args, context: rule.match.context ?? {} });
}

function toolMatches(patterns: Rule["match"]["tools"], toolId: string): boolean {
  return patterns === "*" || patterns.some((pattern) => patternContains(pattern, toolId));
}

function pointerSegments(pointer: string): string[] {
  return pointer === ""
    ? []
    : pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function schemaPointerExists(schema: JsonValueType, pointer: string): boolean | undefined {
  let current: JsonValueType = schema;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }
    const properties = current.properties;
    if (properties !== undefined && properties !== null && typeof properties === "object") {
      if (Array.isArray(properties) || !Object.hasOwn(properties, segment)) {
        return false;
      }
      const next = properties[segment];
      if (next === undefined) {
        return false;
      }
      current = next;
      continue;
    }
    const itemIndex = /^(?:0|[1-9]\d*)$/u.test(segment);
    if (itemIndex && current.items !== undefined) {
      current = current.items;
      continue;
    }
    return undefined;
  }
  return true;
}

function unusedEditablePointers(rule: Rule, metadata: LintToolMetadata): string[] {
  const matchingTools = metadata.filter((tool) => toolMatches(rule.match.tools, tool.toolId));
  if (matchingTools.length === 0) {
    return [];
  }
  return (rule.editable ?? []).filter((pointer) => {
    const checks = matchingTools
      .map((tool) =>
        tool.inputSchema === undefined ? undefined : schemaPointerExists(tool.inputSchema, pointer),
      )
      .filter((result): result is boolean => result !== undefined);
    return checks.length > 0 && checks.every((exists) => !exists);
  });
}

function isShadowed(document: readonly Rule[], rule: Rule, index: number): boolean {
  return document
    .slice(0, index)
    .some(
      (earlier) =>
        decisionRank(earlier.decision) > decisionRank(rule.decision) && ruleIsSubset(rule, earlier),
    );
}

function isDeniedAllow(document: readonly Rule[], rule: Rule): boolean {
  return (
    rule.decision === "allow" &&
    document.some((other) => other.decision === "deny" && ruleIsSubset(rule, other))
  );
}

function isBroadDestructiveAllow(rule: Rule, metadata: LintToolMetadata): boolean {
  return (
    rule.decision === "allow" &&
    (rule.match.args === undefined || rule.match.args.length === 0) &&
    rule.match.tools !== "*" &&
    rule.match.tools.some((pattern) => pattern.endsWith(".*")) &&
    metadata.some((tool) => tool.destructive === true && toolMatches(rule.match.tools, tool.toolId))
  );
}

interface RuleDiagnosticOptions {
  readonly rules: readonly Rule[];
  readonly rule: Rule;
  readonly index: number;
  readonly metadata: LintToolMetadata;
  readonly seenMatchers: Set<string>;
}

function ruleDiagnostics({
  rules,
  rule,
  index,
  metadata,
  seenMatchers,
}: RuleDiagnosticOptions): PolicyLintResult["diagnostics"] {
  const diagnostics: PolicyLintResult["diagnostics"] = [];
  const key = matcherKey(rule);
  if (seenMatchers.has(key)) {
    diagnostics.push(diagnostic("error", "duplicate_matcher", rule.id));
  }
  seenMatchers.add(key);
  if (isShadowed(rules, rule, index)) {
    diagnostics.push(diagnostic("error", "rule_shadowed", rule.id));
  }
  if (isDeniedAllow(rules, rule)) {
    diagnostics.push(diagnostic("error", "allow_fully_denied", rule.id));
  }
  if (isBroadDestructiveAllow(rule, metadata)) {
    diagnostics.push(diagnostic("error", "allow_destructive_wildcard", rule.id));
  }
  diagnostics.push(
    ...unusedEditablePointers(rule, metadata).map(() =>
      diagnostic("error", "unused_editable_pointer", rule.id),
    ),
  );
  return diagnostics;
}

/**
 * Reports policy rule defects without performing I/O or requiring runtime services.
 *
 * Tool metadata is optional; it enables destructive-wildcard and editable-pointer
 * checks when a caller already has metadata available.
 *
 * @param input - Untrusted policy data to validate and lint.
 * @param rawToolMetadata - Optional tool metadata for additional checks.
 * @returns Safe diagnostic codes and rule IDs only.
 */
export function lintPolicy(input: unknown, rawToolMetadata: unknown = []): PolicyLintResult {
  const document = PolicyDocumentSchema.safeParse(input);
  if (!document.success) {
    return invalidDocumentDiagnostics(input, document.error.issues);
  }
  const metadataResult = LintToolMetadataSchema.safeParse(rawToolMetadata);
  const metadata = metadataResult.success ? metadataResult.data : [];
  const diagnostics = metadataResult.success
    ? []
    : [diagnostic("warning", "policy_metadata_invalid")];
  const seenMatchers = new Set<string>();

  for (const [index, rule] of document.data.rules.entries()) {
    diagnostics.push(
      ...ruleDiagnostics({
        rules: document.data.rules,
        rule,
        index,
        metadata,
        seenMatchers,
      }),
    );
  }

  return PolicyLintResultSchema.parse({ diagnostics });
}
