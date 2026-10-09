// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const RunConfigSchema = z
  .object({
    budgets: z
      .object({
        maxSteps: z.coerce.number().int().positive().default(200),
        maxCostUsd: z.coerce.number().positive().optional(),
        maxWallClockMs: z.coerce.number().int().positive().default(3_600_000),
      })
      .strict(),
  })
  .strict();
