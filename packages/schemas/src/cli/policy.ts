// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { JsonValue } from "../json.js";
import { Code } from "../primitives.js";

const PolicyDecisionSchema = z.enum(["allow", "ask", "deny"]);

/** One JSONL call fixture for `harness policy test`. */
export const PolicyTestCallSchema = z
  .object({
    id: Code,
    toolId: Code,
    args: JsonValue,
    context: z
      .object({
        subagent: z.boolean().optional(),
        server: Code.optional(),
        app: Code.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Inferred call fixture accepted by `harness policy test`. */
export type PolicyTestCall = z.infer<typeof PolicyTestCallSchema>;

/** One JSONL expectation for `harness policy test`. */
export const PolicyTestExpectationSchema = z
  .object({
    id: Code,
    decision: PolicyDecisionSchema,
    ruleId: Code.optional(),
  })
  .strict();

/** Inferred expectation accepted by `harness policy test`. */
export type PolicyTestExpectation = z.infer<typeof PolicyTestExpectationSchema>;

const PolicyTestMatchedRuleSchema = z
  .object({
    ruleId: Code,
    decision: PolicyDecisionSchema,
  })
  .strict();

/** One evaluated call in the machine-readable policy test report. */
export const PolicyTestCaseResultSchema = z
  .object({
    id: Code,
    decision: PolicyDecisionSchema,
    ruleId: Code,
    reason: Code,
    matched: z.array(PolicyTestMatchedRuleSchema).optional(),
  })
  .strict();

const PolicyTestMismatchSchema = z
  .object({
    id: Code,
    code: z.enum(["expectation_missing", "call_missing", "decision_mismatch", "rule_id_mismatch"]),
    expected: PolicyTestExpectationSchema.optional(),
    actual: PolicyTestCaseResultSchema.optional(),
  })
  .strict();

/** Machine-readable output from `harness policy test`. */
export const PolicyTestResultSchema = z
  .object({
    results: z.array(PolicyTestCaseResultSchema),
    mismatches: z.array(PolicyTestMismatchSchema),
  })
  .strict();

/** Inferred result returned by `harness policy test`. */
export type PolicyTestResult = z.infer<typeof PolicyTestResultSchema>;

const PolicyLintDiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: Code,
    ruleId: Code.optional(),
  })
  .strict();

/** Machine-readable output from `harness policy lint`. */
export const PolicyLintResultSchema = z
  .object({
    diagnostics: z.array(PolicyLintDiagnosticSchema),
  })
  .strict();

/** Inferred diagnostic result returned by `harness policy lint`. */
export type PolicyLintResult = z.infer<typeof PolicyLintResultSchema>;
