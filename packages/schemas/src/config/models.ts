// SPDX-License-Identifier: Apache-2.0
// Models retry configuration is owned by task 14.12.
import { z } from "zod";

/** Gateway retry and per-attempt timeout policy, owned by model task 14.12. */
export const ModelRetryConfigSchema = z
  .object({
    maxAttempts: z.coerce.number().int().positive().default(3),
    baseDelayMs: z.coerce.number().int().nonnegative().default(500),
    maxDelayMs: z.coerce.number().int().nonnegative().default(20_000),
    timeoutMs: z.coerce.number().int().positive().default(120_000),
  })
  .strict()
  .prefault({});

/** Models configuration fields consumed by the model gateway. */
export const ModelsConfigSchema = z
  .object({
    retry: ModelRetryConfigSchema,
    maxConcurrent: z.coerce.number().int().positive().default(4),
  })
  .strict()
  .prefault({});

/** Inferred retry policy after applying defaults. */
export type ModelRetryConfig = z.infer<typeof ModelRetryConfigSchema>;
/** Inferred model gateway configuration after applying defaults. */
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
