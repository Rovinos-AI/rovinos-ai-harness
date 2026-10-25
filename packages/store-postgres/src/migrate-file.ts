// SPDX-License-Identifier: Apache-2.0
import { Pool } from "pg";
import { z } from "zod";
import {
  migrate,
  StoreUnavailableError,
  type PostgresMigrationDriver,
} from "@rovinos/store/adapter-internal";
import { postgresMigrationDirectory } from "./migration-directory.js";

const migrationOptionsSchema = z
  .object({
    dryRun: z.boolean().default(false),
    appliedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
const postgresConnectionStringSchema = z
  .string()
  .refine(
    (value) =>
      URL.canParse(value) && ["postgres:", "postgresql:"].includes(new URL(value).protocol),
  );

/** Options used by file-backed store migration helpers. */
export type StoreFileMigrationOptions = z.input<typeof migrationOptionsSchema>;

function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new StoreUnavailableError();
  }
  return result.data;
}

/**
 * Apply or list migrations for a Postgres connection.
 *
 * @param connectionString Secret-resolved Postgres connection URL.
 * @param options Dry-run and migration timestamp options.
 * @returns Applied migration versions, or pending versions in dry-run mode.
 */
export async function migratePostgresConnection(
  connectionString: string,
  options: StoreFileMigrationOptions = {},
): Promise<string[]> {
  const parsedConnectionString = validated(postgresConnectionStringSchema, connectionString);
  const parsedOptions = validated(migrationOptionsSchema, options);
  const pool = new Pool({ connectionString: parsedConnectionString });
  try {
    const driver: PostgresMigrationDriver = pool;
    return await migrate(driver, "postgres", {
      ...parsedOptions,
      migrationDirectory: postgresMigrationDirectory(),
    });
  } finally {
    await pool.end();
  }
}
