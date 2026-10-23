// SPDX-License-Identifier: Apache-2.0
import { Code, Id, JsonValue, RunStatus } from "@harness/schemas";
import { SafeEvent } from "@harness/telemetry";
import { z } from "zod";

/** Validated input for the `list_runs` tool. */
export const listRunsInputSchema = z
  .object({
    status: RunStatus.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().optional(),
  })
  .strict();

/** A metadata-only run summary returned by `list_runs`. */
export const controlPlaneRunSummarySchema = z
  .object({
    runId: Id,
    status: RunStatus,
    createdAt: z.number().int().nonnegative(),
    lastTs: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
    pendingApprovals: z.number().int().nonnegative(),
  })
  .strict();

/** Structured metadata-only output for the `list_runs` tool. */
export const listRunsOutputSchema = z
  .object({
    runs: z.array(controlPlaneRunSummarySchema),
    nextCursor: z.string().optional(),
  })
  .strict();

/** Validated input for the `get_run` tool. */
export const getRunInputSchema = z
  .object({
    runId: Id,
    sinceSeq: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Validated input for the `approve` tool. */
export const approveInputSchema = z
  .object({
    approvalId: Id,
    edits: JsonValue.optional(),
  })
  .strict();

/** Validated input for the `deny` tool. */
export const denyInputSchema = z
  .object({
    approvalId: Id,
    reason: Code.optional(),
  })
  .strict();

/** Validated input for run lifecycle tools. */
export const runLifecycleInputSchema = z.object({ runId: Id }).strict();

const runMetadataSchema = z.record(Code, z.union([Code, z.number(), z.boolean()]));

/** Validated input for `start_run`; `goal` is content and is never returned. */
export const startRunInputSchema = z
  .object({
    goal: z.string().min(1).max(8_000),
    metadata: runMetadataSchema.optional(),
    role: Code.optional(),
    idempotencyKey: z.string().min(1).max(256).optional(),
  })
  .strict();

/** Validated input for `continue_run`; `goal` is content and is never returned. */
export const continueRunInputSchema = z
  .object({
    runId: Id,
    goal: z.string().min(1).max(8_000),
    metadata: runMetadataSchema.optional(),
  })
  .strict();

/** Metadata-only success or coded failure returned by run-creation tools. */
export const startRunOutputSchema = z.union([
  z.object({ runId: Id, status: RunStatus }).strict(),
  z.object({ code: Code }).strict(),
]);

/** Metadata-only output for decision tools. */
export const decisionOutputSchema = z
  .object({
    ok: z.boolean(),
    code: Code.optional(),
  })
  .strict();

/** Metadata-only output for `resume_run`. */
export const resumeRunOutputSchema = z
  .object({
    started: z.boolean(),
    code: Code.optional(),
  })
  .strict();

/** Validated TCP port for the loopback HTTP listener; zero requests an ephemeral port. */
export const controlPlaneHttpPortSchema = z.number().int().min(0).max(65_535);

const pendingApprovalSchema = z
  .object({
    approvalId: Id,
    toolId: Code,
    ruleId: Code,
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Structured metadata-only output for the `get_run` tool. */
export const getRunOutputSchema = z
  .object({
    runId: Id,
    createdAt: z.number().int().nonnegative(),
    status: RunStatus,
    lastSeq: z.number().int().nonnegative(),
    lastTs: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        costMicros: z.number().int().nonnegative(),
      })
      .strict(),
    lastCheckpoint: z
      .object({ checkpointId: Id, atSeq: z.number().int().nonnegative() })
      .strict()
      .optional(),
    pendingApprovals: z.array(pendingApprovalSchema),
    recentEvents: z.array(SafeEvent),
  })
  .strict();

/** Inferred input for `list_runs`. */
export type ListRunsInput = z.input<typeof listRunsInputSchema>;
/** Inferred structured output for `list_runs`. */
export type ListRunsOutput = z.infer<typeof listRunsOutputSchema>;
/** Inferred input for `get_run`. */
export type GetRunInput = z.input<typeof getRunInputSchema>;
/** Inferred structured output for `get_run`. */
export type GetRunOutput = z.infer<typeof getRunOutputSchema>;
/** Inferred input for `approve`. */
export type ApproveInput = z.input<typeof approveInputSchema>;
/** Inferred input for `deny`. */
export type DenyInput = z.input<typeof denyInputSchema>;
/** Inferred metadata-only decision output. */
export type DecisionOutput = z.infer<typeof decisionOutputSchema>;
/** Inferred metadata-only resume output. */
export type ResumeRunOutput = z.infer<typeof resumeRunOutputSchema>;
/** Inferred input for `start_run`. */
export type StartRunInput = z.infer<typeof startRunInputSchema>;
/** Inferred input for `continue_run`. */
export type ContinueRunInput = z.infer<typeof continueRunInputSchema>;
/** Inferred output for run-creation tools. */
export type StartRunOutput = z.infer<typeof startRunOutputSchema>;
