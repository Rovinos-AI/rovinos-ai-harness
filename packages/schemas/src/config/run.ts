// SPDX-License-Identifier: Apache-2.0
// Run config is owned by task 20.1; resume policy and checkpoint cadence are added by tasks 2.5 and 2.6.
import { z } from "zod";

/** Policy for dangling non-idempotent tool intents encountered during resume. */
export const RunResumePolicySchema = z.enum(["escalate", "fail"]).default("escalate");

export const RunConfigSchema = z
  .object({
    checkpointEveryEvents: z.coerce.number().int().positive().default(20),
    resume: z
      .object({
        onNonIdempotent: RunResumePolicySchema,
      })
      .strict()
      .prefault({}),
    budgets: z
      .object({
        maxSteps: z.coerce.number().int().positive().default(200),
        maxCostUsd: z.coerce.number().positive().optional(),
        maxWallClockMs: z.coerce.number().int().positive().default(3_600_000),
        countSuspendedTime: z
          .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
          .default(false),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});

/** The validated run configuration, including defaults. */
export type RunConfig = z.infer<typeof RunConfigSchema>;
