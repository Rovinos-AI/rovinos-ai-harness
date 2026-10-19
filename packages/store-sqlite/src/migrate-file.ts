// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import { migrate, StoreUnavailableError } from "@harness/store/adapter-internal";
import { openReadOnlyDatabase } from "./sqlite/read-only.js";

const migrationOptionsSchema = z
  .object({
    dryRun: z.boolean().default(false),
    appliedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
const filePathSchema = z.string().min(1);

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
  if (!parsedOptions.dryRun) {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  let db: Database.Database;
  if (!parsedOptions.dryRun) {
    db = new Database(databasePath);
  } else if (existsSync(databasePath)) {
    db = openReadOnlyDatabase(databasePath);
  } else {
    db = new Database(":memory:");
  }
  try {
    return migrate(db, "sqlite", {
      ...parsedOptions,
      migrationDirectory: fileURLToPath(new URL("../migrations/sqlite/", import.meta.url)),
    });
  } finally {
    db.close();
  }
}
