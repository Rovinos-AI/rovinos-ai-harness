// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { z } from "zod";

export const RunnerOkResponseSchema = z.object({ status: z.literal("ok") }).strict();
export const RunnerLeaseRequestSchema = z
  .object({
    runId: Id,
    ttlMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict();
export const RunnerReleaseRequestSchema = z.object({ runId: Id }).strict();
