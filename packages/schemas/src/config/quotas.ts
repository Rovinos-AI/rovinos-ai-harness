// SPDX-License-Identifier: Apache-2.0
// Quota configuration is owned by task 24.7.
import { z } from "zod";
import { Code } from "../primitives.js";

/** Principal and role selectors that associate runs with a quota. */
export const QuotaMatchSchema = z
  .object({
    requestedBy: z.array(Code).optional(),
    role: z.array(Code).optional(),
  })
  .strict();

/** A cross-run cost, concurrency, and rate limit. */
export const QuotaConfigSchema = z
  .object({
    id: Code,
    match: QuotaMatchSchema,
    dailyCostUsd: z.number().positive().optional(),
    monthlyCostUsd: z.number().positive().optional(),
    maxConcurrentRuns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Currently inert; enforced by workers in task 24.3."),
    maxRunsPerHour: z.number().int().positive().optional(),
  })
  .strict();

/** The configured quota set. */
export const QuotasConfigSchema = z
  .array(QuotaConfigSchema)
  .default([])
  .superRefine((quotas, ctx) => {
    const ids = new Set<string>();
    for (const [index, quota] of quotas.entries()) {
      if (ids.has(quota.id)) {
        ctx.addIssue({ code: "custom", path: [index, "id"], message: "Quota ids must be unique" });
      }
      ids.add(quota.id);
    }
  });

/** Inferred quota configuration. */
export type QuotaConfig = z.infer<typeof QuotaConfigSchema>;
/** Inferred configured quota set. */
export type QuotasConfig = z.infer<typeof QuotasConfigSchema>;
