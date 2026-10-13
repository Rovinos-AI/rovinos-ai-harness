// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** JSON result for `harness store migrate`. */
export const StoreMigrateResultSchema = z
  .object({
    applied: z.array(z.string().regex(/^\d{4}$/)),
    pending: z.array(z.string().regex(/^\d{4}$/)),
  })
  .strict();

/** Inferred JSON result for `harness store migrate`. */
export type StoreMigrateResult = z.infer<typeof StoreMigrateResultSchema>;

/** JSON result for `harness store purge`. */
export const StorePurgeResultSchema = z
  .object({
    examined: z.number().int().nonnegative(),
    purged: z.number().int().nonnegative(),
    skippedActive: z.number().int().nonnegative(),
    hookFailures: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred JSON result for `harness store purge`. */
export type StorePurgeResult = z.infer<typeof StorePurgeResultSchema>;
