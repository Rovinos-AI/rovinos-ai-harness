// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { z } from "zod";
import { StoreUnavailableError } from "./errors.js";
import { migrate, type PostgresMigrationDriver } from "./migrate.js";
import { openReadOnlyDatabase } from "./sqlite/read-only.js";

const migrationOptionsSchema = z
  .object({
    dryRun: z.boolean().default(false),
    appliedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
const filePathSchema = z.string().min(1);
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
 * Apply or list migrations for a SQLite database file.
 *
 * A dry run of a missing database uses an in-memory database so it does not create
 * a file as a side effect.
 *
 * @param path SQLite database file path.
 * @param options Dry-run and migration timestamp options.
 * @returns Applied migration versions, or pending versions in dry-run mode.
 */
export function migrateSqliteFile(path: string, options: StoreFileMigrationOptions = {}): string[] {
  const databasePath = validated(filePathSchema, path);
  const parsedOptions = validated(migrationOptionsSchema, options);
  const dryRun = parsedOptions.dryRun;
  if (!dryRun) {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  let db: Database.Database;
  if (dryRun) {
    db = existsSync(databasePath) ? openReadOnlyDatabase(databasePath) : new Database(":memory:");
  } else {
    db = new Database(databasePath);
  }
  try {
    return migrate(db, "sqlite", parsedOptions);
  } finally {
    db.close();
  }
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
    return await migrate(driver, "postgres", parsedOptions);
  } finally {
    await pool.end();
  }
}
