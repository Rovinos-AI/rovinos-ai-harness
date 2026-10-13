// SPDX-License-Identifier: Apache-2.0
import { Code, Id, RunStatus } from "@harness/schemas";
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
export const getRunInputSchema = z.object({ runId: Id }).strict();

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
    status: RunStatus,
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
