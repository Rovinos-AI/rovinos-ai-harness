// SPDX-License-Identifier: Apache-2.0
// Vault purge configuration is owned by task 12.6.
import { z } from "zod";

const purgeAfterDaysSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000))
  .default(7);

/** Vault post-completion retention settings. */
export const VaultConfigSchema = z
  .object({
    purgeAfterDays: purgeAfterDaysSchema,
  })
  .strict()
  .prefault({});

/** Inferred vault retention settings. */
export type VaultConfig = z.infer<typeof VaultConfigSchema>;
