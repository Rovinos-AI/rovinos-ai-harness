// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { VaultOperationError } from "./errors.js";

const MIGRATIONS = [
  {
    version: "0001_init",
    path: fileURLToPath(new URL("../migrations/sqlite/0001_init.sql", import.meta.url)),
  },
  {
    version: "0002_purge_epochs",
    path: fileURLToPath(new URL("../migrations/sqlite/0002_purge_epochs.sql", import.meta.url)),
  },
  {
    version: "0003_run_meta",
    path: fileURLToPath(new URL("../migrations/sqlite/0003_run_meta.sql", import.meta.url)),
  },
  {
    version: "0004_lookup_key_id",
    path: fileURLToPath(new URL("../migrations/sqlite/0004_lookup_key_id.sql", import.meta.url)),
  },
  {
    version: "0005_nullable_lookup",
    path: fileURLToPath(new URL("../migrations/sqlite/0005_nullable_lookup.sql", import.meta.url)),
  },
  {
    version: "0006_scope_keys",
    path: fileURLToPath(new URL("../migrations/sqlite/0006_scope_keys.sql", import.meta.url)),
  },
] as const;

interface MigrationRow {
  version: string;
  checksum: string;
}

function readMigration(path: string): { checksum: string; sql: string } {
  const sql = readFileSync(path, "utf8");
  return { checksum: createHash("sha256").update(sql).digest("hex"), sql };
}

/** Applies checksum-validated vault migrations to a writable database. */
export function migrateVault(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const knownVersions = new Set<string>(MIGRATIONS.map(({ version }) => version));
  const appliedVersions = db
    .prepare<[], MigrationRow>("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all();
  if (appliedVersions.some(({ version }) => !knownVersions.has(version))) {
    throw new VaultOperationError("vault_migration_newer_than_code");
  }

  const readApplied = db.prepare<[string], MigrationRow>(
    "SELECT version, checksum FROM schema_migrations WHERE version = ?",
  );
  const recordApplied = db.prepare<[string, string, number]>(
    "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    const { checksum, sql } = readMigration(migration.path);
    const applied = readApplied.get(migration.version);
    if (applied !== undefined) {
      if (applied.checksum !== checksum) {
        throw new VaultOperationError("vault_migration_checksum_mismatch");
      }
      continue;
    }

    const apply = db.transaction(() => {
      db.exec(sql);
      recordApplied.run(migration.version, checksum, Date.now());
    });
    apply.immediate();
  }
}

/** Verifies the migration history without writing to a read-only database. */
export function validateReadOnlyVaultMigrations(db: Database.Database): void {
  const table = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (table === undefined) {
    throw new VaultOperationError("schema_migration_pending");
  }
  const knownVersions = new Set<string>(MIGRATIONS.map(({ version }) => version));
  const appliedVersions = db
    .prepare<[], MigrationRow>("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all();
  if (appliedVersions.some(({ version }) => !knownVersions.has(version))) {
    throw new VaultOperationError("vault_migration_newer_than_code");
  }
  const appliedByVersion = new Map(appliedVersions.map((row) => [row.version, row.checksum]));
  for (const migration of MIGRATIONS) {
    const appliedChecksum = appliedByVersion.get(migration.version);
    if (appliedChecksum === undefined) {
      throw new VaultOperationError("schema_migration_pending");
    }
    if (appliedChecksum !== readMigration(migration.path).checksum) {
      throw new VaultOperationError("vault_migration_checksum_mismatch");
    }
  }
}
