// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code, Id } from "../primitives.js";
import { JsonValue } from "../json.js";
import { RunStatus } from "../events.js";
import { JsonPointerSchema } from "../config/pii.js";

/** One pending approval row returned by `harness approvals list`. */
export const ApprovalSummarySchema = z
  .object({
    approvalId: Id,
    runId: Id,
    toolId: Code,
    ruleId: Code,
    requestedAt: z.number().int().nonnegative(),
    ageMs: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** Inferred pending approval row. */
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

/** Result of `harness approvals list`. */
export const ApprovalListResultSchema = z
  .object({ approvals: z.array(ApprovalSummarySchema) })
  .strict();

/** Inferred result of `harness approvals list`. */
export type ApprovalListResult = z.infer<typeof ApprovalListResultSchema>;

/** Result of `harness approvals show`; `args` and `revealed` require explicit flags. */
export const ApprovalShowResultSchema = ApprovalSummarySchema.extend({
  callId: Id,
  reason: Code,
  editableFields: z.array(JsonPointerSchema),
  args: JsonValue.optional(),
  revealed: JsonValue.optional(),
}).strict();

/** Inferred result of `harness approvals show`. */
export type ApprovalShowResult = z.infer<typeof ApprovalShowResultSchema>;

/** Result of `harness approvals approve` and `harness approvals deny`. */
export const ApprovalResolveResultSchema = z
  .object({
    approvalId: Id,
    runId: Id,
    decision: z.enum(["approve", "edit", "deny"]),
    resumedStatus: RunStatus.optional(),
  })
  .strict();

/** Inferred result of resolving an approval. */
export type ApprovalResolveResult = z.infer<typeof ApprovalResolveResultSchema>;
