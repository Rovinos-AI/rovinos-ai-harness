// SPDX-License-Identifier: Apache-2.0
import { Code, JsonPointerSchema, JsonValue, isRegexSafePattern } from "@harness/schemas";
import type { JsonPointer } from "@harness/schemas";
import { z } from "zod";

const ToolPatternSchema = z
  .string()
  .refine((pattern) => {
    if (pattern === "*") {
      return true;
    }
    return Code.safeParse(pattern.endsWith(".*") ? pattern.slice(0, -2) : pattern).success;
  })
  .refine(
    (pattern) =>
      pattern === "*" ||
      !pattern.includes("*") ||
      (pattern.endsWith(".*") && pattern.indexOf("*") === pattern.length - 1),
    { message: "Tool patterns may only use a trailing .* wildcard." },
  );

/** Match a tokenized tool argument at an RFC 6901 pointer. */
export const ArgMatcherSchema = z
  .object({
    pointer: JsonPointerSchema,
    op: z.enum(["equals", "in", "startsWith", "matches", "exists", "tokenType"]),
    value: JsonValue.optional(),
  })
  .strict()
  .superRefine((matcher, context) => {
    if (matcher.op === "exists") {
      return;
    }
    if (matcher.value === undefined) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "This matcher operation requires a value.",
        params: { errorCode: "policy_match_value_required" },
      });
      return;
    }
    if (matcher.op === "in" && !Array.isArray(matcher.value)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "The in operation requires an array value.",
        params: { errorCode: "policy_match_value_invalid" },
      });
    }
    if (
      (matcher.op === "startsWith" || matcher.op === "matches") &&
      typeof matcher.value !== "string"
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "This matcher operation requires a string value.",
        params: { errorCode: "policy_match_value_invalid" },
      });
      return;
    }
    if (matcher.op === "matches" && typeof matcher.value === "string") {
      if (!isRegexSafePattern(matcher.value)) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "The regular expression is not safe.",
          params: { errorCode: "policy_pattern_unsafe" },
        });
      }
      try {
        new RegExp(matcher.value);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "The regular expression is invalid.",
          params: { errorCode: "policy_pattern_invalid" },
        });
      }
    }
    if (
      matcher.op === "tokenType" &&
      (typeof matcher.value !== "string" || !Code.safeParse(matcher.value).success)
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "The token type must be a code.",
        params: { errorCode: "policy_token_type_invalid" },
      });
    }
  });

/** Inferred argument matcher contract. */
export type ArgMatcher = z.infer<typeof ArgMatcherSchema>;

const RuleMatchSchema = z
  .object({
    tools: z.union([ToolPatternSchema, z.array(ToolPatternSchema).min(1)]),
    args: z.array(ArgMatcherSchema).optional(),
    context: z
      .object({
        subagent: z.boolean().optional(),
        server: Code.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** One policy decision rule. */
export const RuleSchema = z
  .object({
    id: Code,
    description: z.string().optional(),
    match: RuleMatchSchema,
    decision: z.enum(["allow", "ask", "deny"]),
    reason: Code,
    editable: z.array(JsonPointerSchema).optional(),
    approvalTtlMs: z.number().int().nonnegative().optional(),
    escalateAfterMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    const allowsEveryTool =
      rule.match.tools === "*" ||
      (Array.isArray(rule.match.tools) && rule.match.tools.includes("*"));
    if (allowsEveryTool && rule.decision === "allow") {
      context.addIssue({
        code: "custom",
        path: ["match", "tools"],
        message: "A rule cannot allow every tool.",
        params: { errorCode: "policy_allow_all" },
      });
    }
    if (rule.editable !== undefined && rule.decision !== "ask") {
      context.addIssue({
        code: "custom",
        path: ["editable"],
        message: "Editable pointers require an ask decision.",
        params: { errorCode: "policy_editable_requires_ask" },
      });
    }
    if (rule.escalateAfterMs !== undefined && rule.decision !== "ask") {
      context.addIssue({
        code: "custom",
        path: ["escalateAfterMs"],
        message: "Escalation requires an ask decision.",
        params: { errorCode: "policy_escalation_requires_ask" },
      });
    }
  });

/** Inferred policy rule contract. */
export type Rule = z.infer<typeof RuleSchema>;

/** Strict policy document format, version 1. */
export const PolicyDocumentSchema = z
  .object({
    version: z.literal(1),
    defaultDecision: z.enum(["ask", "deny"]),
    rules: z.array(RuleSchema),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    for (const [index, rule] of document.rules.entries()) {
      if (ids.has(rule.id)) {
        context.addIssue({
          code: "custom",
          path: ["rules", index, "id"],
          message: "Rule ids must be unique.",
          params: { errorCode: "policy_rule_id_duplicate" },
        });
      }
      ids.add(rule.id);
    }
  });

/** Inferred policy document contract. */
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

/** Re-export of the validated JSON Pointer type used by policy rules. */
export type { JsonPointer };
