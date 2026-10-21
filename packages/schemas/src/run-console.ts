// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { RunStatus } from "./events.js";
import { Code, Id } from "./primitives.js";

/** Safe metadata displayed for each run in the runs console. */
export const RunConsoleRunSchema = z
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

/** Metadata-only output consumed by the runs console list view. */
export const RunConsoleListSchema = z
  .object({
    runs: z.array(RunConsoleRunSchema),
    nextCursor: z.string().optional(),
  })
  .strict();

/** Metadata-only pending approval shown in a run detail panel. */
const RunConsolePendingApprovalSchema = z
  .object({
    approvalId: Id,
    toolId: Code,
    ruleId: Code,
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Metadata-only fields rendered from a `get_run` response. */
export const RunConsoleDetailSchema = z
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
    pendingApprovals: z.array(RunConsolePendingApprovalSchema),
  });

/** Inferred safe list output for the runs console. */
export type RunConsoleList = z.infer<typeof RunConsoleListSchema>;
/** Inferred safe run summary displayed by the console. */
export type RunConsoleRun = z.infer<typeof RunConsoleRunSchema>;
/** Inferred safe detail projection for the runs console. */
export type RunConsoleDetail = z.infer<typeof RunConsoleDetailSchema>;
