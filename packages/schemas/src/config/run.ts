// SPDX-License-Identifier: Apache-2.0
// Placeholder owned by task 20.1.
import { z } from "zod";

export const RunConfigSchema = z
  .object({
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
