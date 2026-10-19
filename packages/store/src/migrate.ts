// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { systemClock } from "./types.js";
import { StoreMigrationError } from "./errors.js";

const migrationFileSchema = z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/);
const optionsSchema = z
  .object({
    dryRun: z.boolean().default(false),
    migrationDirectory: z.string().min(1),
    appliedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

interface Migration {
  version: string;
  checksum: string;
  sql: string;
}

interface MigrationRow {
  version: string;
  checksum: string;
}
type MigrationOptions = z.input<typeof optionsSchema>;
const migrationRowSchema = z.object({ version: z.string(), checksum: z.string() }).strict();

/** Minimal SQLite connection surface accepted by {@link migrate}. */
export interface SqliteMigrationDriver {
  /** Execute SQL that does not bind values. */
  exec(query: string): unknown;
  /** Prepare a parameterized statement used by the migration runner. */
  prepare<BindParameters extends unknown[] = [], Result = unknown>(
    query: string,
  ): SqliteMigrationStatement<BindParameters, Result>;
  /** Create an immediate transaction for applying the migration set. */
  transaction<Result>(callback: () => Result): { immediate(): Result };
}

/** Minimal SQLite statement surface used to read and record migration history. */
export interface SqliteMigrationStatement<BindParameters extends unknown[], Result> {
  /** Read a single migration-history row. */
  get(...parameters: BindParameters): Result | undefined;
  /** Read all migration-history rows. */
  all(...parameters: BindParameters): Result[];
  /** Insert a migration-history row. */
  run(...parameters: BindParameters): unknown;
}

/** Minimal Postgres client surface used to apply a migration transaction. */
export interface PostgresMigrationClient {
  /** Execute a parameterized statement on the current transaction. */
  query(query: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** Return the connection to its pool. */
  release(): void;
}

/** Minimal pooled Postgres driver surface accepted by {@link migrate}. */
export interface PostgresMigrationDriver {
  /** Execute a query outside a transaction, used only for dry runs. */
  query(query: string): Promise<{ rows: Record<string, unknown>[] }>;
  /** Acquire a connection for a serialized migration transaction. */
  connect(): Promise<PostgresMigrationClient>;
}

function loadMigrations(directory: string): Migration[] {
  const migrationDirectory = directory;
  const files = readdirSync(migrationDirectory)
    .filter((filename) => filename.endsWith(".sql"))
    .map((filename) => migrationFileSchema.parse(filename))
    .sort();
  const versions = files.map((filename) => filename.slice(0, 4));
  if (new Set(versions).size !== versions.length) {
    throw new StoreMigrationError("migration_set_invalid");
  }
  const migrations = files.map((filename) => {
    const sql = readFileSync(join(migrationDirectory, filename), "utf8");
    return {
      version: filename.slice(0, 4),
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql,
    };
  });
  return migrations;
}

function pendingMigrations(
  migrations: readonly Migration[],
  applied: readonly MigrationRow[],
): Migration[] {
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = known.get(row.version);
    if (migration === undefined) {
      throw new StoreMigrationError("schema_newer_than_code");
    }
    if (migration.checksum !== row.checksum) {
      throw new StoreMigrationError("migration_checksum_mismatch");
    }
  }
  const appliedVersions = new Set(applied.map(({ version }) => version));
  return migrations.filter(({ version }) => !appliedVersions.has(version));
}

function migrateSqlite(
  db: SqliteMigrationDriver,
  migrations: readonly Migration[],
  dryRun: boolean,
  appliedAt: number,
): string[] {
  const hasHistory = (): boolean =>
    db
      .prepare<[string, string], { present: number }>(
        "SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?",
      )
      .get("table", "schema_migrations") !== undefined;
  const readHistory = (): MigrationRow[] =>
    db
      .prepare<[], MigrationRow>("SELECT version, checksum FROM schema_migrations ORDER BY version")
      .all();
  if (dryRun) {
    return pendingMigrations(migrations, hasHistory() ? readHistory() : []).map(
      ({ version }) => version,
    );
  }

  const runMigrations = db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const pending = pendingMigrations(migrations, readHistory());
    const recordApplied = db.prepare<[string, string, number], unknown>(
      "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
    );
    for (const migration of pending) {
      db.exec(migration.sql);
      recordApplied.run(migration.version, migration.checksum, appliedAt);
    }
    return pending.map(({ version }) => version);
  });
  return runMigrations.immediate();
}

async function migratePostgres(
  pool: PostgresMigrationDriver,
  migrations: readonly Migration[],
  dryRun: boolean,
  appliedAt: number,
): Promise<string[]> {
  if (dryRun) {
    const historyTable = await pool.query(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    );
    if (historyTable.rows[0]?.present !== true) {
      return migrations.map(({ version }) => version);
    }
    const history = await pool.query(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    return pendingMigrations(
      migrations,
      history.rows.map((row) => migrationRowSchema.parse(row)),
    ).map(({ version }) => version);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema())::bigint)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)",
    );
    const history = await client.query(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    const pending = pendingMigrations(
      migrations,
      history.rows.map((row) => migrationRowSchema.parse(row)),
    );
    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)",
        [migration.version, migration.checksum, appliedAt],
      );
    }
    await client.query("COMMIT");
    return pending.map(({ version }) => version);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Apply the store's ordered, checksummed schema migrations to SQLite.
 * @param driver SQLite database connection.
 * @param dialect SQL dialect for the connection.
 * @param opts Dry-run, migration-directory, and timestamp options.
 * @returns Versions pending before this call, or pending versions in dry-run mode.
 */
export function migrate<TDriver extends object>(
  driver: TDriver,
  dialect: "sqlite",
  opts: MigrationOptions,
): string[];
/**
 * Apply the store's ordered, checksummed schema migrations to Postgres.
 * @param driver Pooled Postgres connection.
 * @param dialect SQL dialect for the connection.
 * @param opts Dry-run, migration-directory, and timestamp options.
 * @returns Versions pending before this call, or pending versions in dry-run mode.
 */
export function migrate(
  driver: PostgresMigrationDriver,
  dialect: "postgres",
  opts: MigrationOptions,
): Promise<string[]>;
export function migrate(
  driver: object,
  dialect: "sqlite" | "postgres",
  opts: MigrationOptions,
): string[] | Promise<string[]> {
  const options = optionsSchema.parse(opts);
  const migrations = loadMigrations(options.migrationDirectory);
  const appliedAt = options.appliedAt ?? (options.dryRun ? 0 : systemClock.now());
  if (dialect === "sqlite") {
    if (!isSqliteMigrationDriver(driver)) {
      throw new TypeError("Migration driver does not match dialect");
    }
    return migrateSqlite(driver, migrations, options.dryRun, appliedAt);
  }
  if (!isPostgresMigrationDriver(driver)) {
    throw new TypeError("Migration driver does not match dialect");
  }
  return migratePostgres(driver, migrations, options.dryRun, appliedAt);
}

function isSqliteMigrationDriver(driver: object): driver is SqliteMigrationDriver {
  return (
    "exec" in driver &&
    typeof driver.exec === "function" &&
    "prepare" in driver &&
    typeof driver.prepare === "function" &&
    "transaction" in driver &&
    typeof driver.transaction === "function"
  );
}

function isPostgresMigrationDriver(driver: object): driver is PostgresMigrationDriver {
  return (
    "query" in driver &&
    typeof driver.query === "function" &&
    "connect" in driver &&
    typeof driver.connect === "function"
  );
}
