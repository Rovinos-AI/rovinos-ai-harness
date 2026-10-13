// SPDX-License-Identifier: Apache-2.0
// Store config is owned by task 7.11.
import { z } from "zod";

const retentionDays = z.coerce
  .number()
  .int()
  .positive()
  .max(Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000));

/** Run retention windows; cancelled runs use the failed-run window. */
export const StoreRetentionConfigSchema = z
  .object({
    completedRunsDays: retentionDays,
    failedRunsDays: retentionDays,
  })
  .strict();

/** Validated run and snapshot retention settings. */
export type StoreRetentionConfig = z.infer<typeof StoreRetentionConfigSchema>;

/** Event-store configuration; retention is disabled until explicitly configured. */
export const StoreConfigSchema = z
  .object({ retention: StoreRetentionConfigSchema.optional() })
  .strict()
  .prefault({});
