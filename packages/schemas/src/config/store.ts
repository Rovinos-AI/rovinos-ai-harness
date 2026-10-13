// SPDX-License-Identifier: Apache-2.0
// Store config is owned by task 7.11.
import { z } from "zod";

const retentionDays = z.coerce
  .number()
  .int()
  .positive()
  .max(Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000));

/** Run and snapshot retention settings for the event store. */
export const StoreRetentionConfigSchema = z
  .object({
    completedRunsDays: retentionDays,
    failedRunsDays: retentionDays,
    snapshotKeep: z.coerce.number().int().min(1).default(5),
  })
  .strict();

/** Validated run and snapshot retention settings. */
export type StoreRetentionConfig = z.infer<typeof StoreRetentionConfigSchema>;

/** Event-store configuration; retention is disabled until explicitly configured. */
export const StoreConfigSchema = z
  .object({ retention: StoreRetentionConfigSchema.optional() })
  .strict()
  .prefault({});
