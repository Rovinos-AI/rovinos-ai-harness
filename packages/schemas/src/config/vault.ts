// SPDX-License-Identifier: Apache-2.0
// Vault purge configuration is owned by task 12.6.
import { z } from "zod";
import { SecretRefSchema } from "../secret-ref.js";

const purgeAfterDaysSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000))
  .default(7);

/** Vault post-completion retention settings. */
export const VaultConfigSchema = z
  .object({
    backend: z.enum(["sqlite", "postgres"]).default("sqlite"),
    purgeAfterDays: purgeAfterDaysSchema,
    postgres: z
      .object({
        url: SecretRefSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    ({ backend, postgres }) =>
      backend === "postgres" ? postgres !== undefined : postgres === undefined,
    {
      path: ["postgres"],
      message: "Postgres vault URL is required only for the Postgres backend",
    },
  )
  .prefault({});

/** Inferred vault retention settings. */
export type VaultConfig = z.infer<typeof VaultConfigSchema>;
