// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrate,
  type PostgresMigrationClient,
  type PostgresMigrationDriver,
} from "@harness/store/adapter-internal";
import { StoreMigrationError } from "@harness/store";

const sqliteMigrationDirectory = fileURLToPath(
  new URL("../packages/store-sqlite/migrations/sqlite/", import.meta.url),
);

const temporaryDirectories: string[] = [];

class FakePostgresDriver implements PostgresMigrationDriver {
  readonly history = new Map<string, string>();
  readonly statements: string[] = [];
  historyTable = false;
  private backup:
    { history: Map<string, string>; historyTable: boolean; statements: string[] } | undefined;

  query(query: string): Promise<{ rows: Record<string, unknown>[] }> {
    if (query.startsWith("SELECT to_regclass")) {
      return Promise.resolve({ rows: [{ present: this.historyTable }] });
    }
    if (query.startsWith("SELECT version, checksum FROM schema_migrations")) {
      return Promise.resolve({
        rows: [...this.history].map(([version, checksum]) => ({ version, checksum })),
      });
    }
    return Promise.resolve({ rows: [] });
  }

  connect(): Promise<PostgresMigrationClient> {
    return Promise.resolve({
      query: (query, values = []) => {
        if (query === "BEGIN") {
          this.backup = {
            history: new Map(this.history),
            historyTable: this.historyTable,
            statements: [...this.statements],
          };
        } else if (query === "ROLLBACK" && this.backup !== undefined) {
          this.history.clear();
          for (const [version, checksum] of this.backup.history) {
            this.history.set(version, checksum);
          }
          this.historyTable = this.backup.historyTable;
          this.statements.splice(0, this.statements.length, ...this.backup.statements);
          this.backup = undefined;
        } else if (query === "COMMIT") {
          this.backup = undefined;
        } else if (query.startsWith("SELECT version, checksum FROM schema_migrations")) {
          return Promise.resolve({
            rows: [...this.history].map(([version, checksum]) => ({ version, checksum })),
          });
        } else if (query.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
          this.historyTable = true;
        } else if (query.startsWith("INSERT INTO schema_migrations")) {
          const version = values[0];
          const checksum = values[1];
          if (typeof version !== "string" || typeof checksum !== "string") {
            throw new TypeError("Invalid migration history parameters");
          }
          this.history.set(version, checksum);
        } else if (query.startsWith("-- SPDX")) {
          if (query.includes("FAIL")) {
            throw new Error("Synthetic migration failure");
          }
          this.statements.push(query);
        }
        return Promise.resolve({ rows: [] });
      },
      release: () => undefined,
    });
  }
}

function migrationErrorCode(action: () => void): StoreMigrationError["code"] {
  try {
    action();
    throw new Error("Expected migration to fail");
  } catch (error) {
    if (!(error instanceof StoreMigrationError)) {
      throw error;
    }
    return error.code;
  }
}

async function temporaryMigrations(sql: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-migrations-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "0001_init.sql"), sql);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("SQLite schema migrations", () => {
  it("lists pending migrations without creating schema and applies them only once", async () => {
    const directory = await temporaryMigrations("CREATE TABLE marker (id INTEGER PRIMARY KEY);");
    const db = new Database(":memory:");

    expect(migrate(db, "sqlite", { migrationDirectory: directory, dryRun: true })).toEqual([
      "0001",
    ]);
    expect(
      db
        .prepare<[string], { count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = ?",
        )
        .get("table")?.count,
    ).toBe(0);
    expect(migrate(db, "sqlite", { migrationDirectory: directory, appliedAt: 1 })).toEqual([
      "0001",
    ]);
    expect(migrate(db, "sqlite", { migrationDirectory: directory, appliedAt: 2 })).toEqual([]);
    expect(
      db.prepare("SELECT version, checksum, applied_at FROM schema_migrations").get(),
    ).toMatchObject({
      version: "0001",
      applied_at: 1,
    });
    db.close();
  });

  it("rejects migration file checksum drift", async () => {
    const directory = await temporaryMigrations("CREATE TABLE marker (id INTEGER PRIMARY KEY);");
    const db = new Database(":memory:");

    migrate(db, "sqlite", { migrationDirectory: directory });
    await writeFile(
      join(directory, "0001_init.sql"),
      "CREATE TABLE changed (id INTEGER PRIMARY KEY);",
    );

    expect(migrationErrorCode(() => migrate(db, "sqlite", { migrationDirectory: directory }))).toBe(
      "migration_checksum_mismatch",
    );
    db.close();
  });

  it("refuses migration history newer than this code", async () => {
    const directory = await temporaryMigrations("CREATE TABLE marker (id INTEGER PRIMARY KEY);");
    const db = new Database(":memory:");

    migrate(db, "sqlite", { migrationDirectory: directory });
    db.prepare(
      "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
    ).run("9999_future", "synthetic-checksum", 1);

    expect(migrationErrorCode(() => migrate(db, "sqlite", { migrationDirectory: directory }))).toBe(
      "schema_newer_than_code",
    );
    expect(new StoreMigrationError("schema_newer_than_code").code).toBe("schema_newer_than_code");
    db.close();
  });

  it("loads and applies the checked-in schema with the required indexes and tables", () => {
    const db = new Database(":memory:");
    expect(migrate(db, "sqlite", { migrationDirectory: sqliteMigrationDirectory })).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
    ]);
    const names = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name",
      )
      .all()
      .map(({ name }) => name);
    expect(names).toEqual(
      expect.arrayContaining([
        "events",
        "events_trace_id_idx",
        "runs",
        "runs_status_created_at_idx",
        "snapshots",
        "snapshots_run_at_seq_idx",
        "sink_cursors",
        "store_metadata",
        "approval_notifications",
        "approval_notifications_run_id_idx",
        "control_plane_consumed_states",
        "idempotency_keys",
        "idempotency_keys_run_id_idx",
      ]),
    );
    expect(db.prepare("PRAGMA table_info(events)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "global_seq" })]),
    );
    db.close();
  });

  it("rejects malformed migration file names", async () => {
    const directory = await temporaryMigrations("CREATE TABLE marker (id INTEGER PRIMARY KEY);");
    await writeFile(join(directory, "bad-name.sql"), "SELECT 1;");
    const db = new Database(":memory:");

    expect(() => migrate(db, "sqlite", { migrationDirectory: directory })).toThrow();
    db.close();
  });

  it("rejects migration files with duplicate numeric versions", async () => {
    const directory = await temporaryMigrations("CREATE TABLE marker (id INTEGER PRIMARY KEY);");
    await writeFile(join(directory, "0001_other.sql"), "SELECT 1;");
    const db = new Database(":memory:");

    expect(migrationErrorCode(() => migrate(db, "sqlite", { migrationDirectory: directory }))).toBe(
      "migration_set_invalid",
    );
    db.close();
  });

  it("keeps the migration source files readable from the package", async () => {
    const directory = new URL("../packages/store-sqlite/migrations/sqlite/", import.meta.url);
    expect(await readdir(directory)).toContain("0001_init.sql");
    expect(await readdir(directory)).toContain("0002_approval_notifications.sql");
    expect(await readdir(directory)).toContain("0003_confirmation_states.sql");
    expect(await readdir(directory)).toContain("0004_idempotency_keys.sql");
    expect(await readFile(new URL("0001_init.sql", directory), "utf8")).toContain(
      "CREATE TABLE IF NOT EXISTS events",
    );
  });
});

describe("Postgres schema migrations", () => {
  it("reports pending migrations in dry-run mode and applies them once", async () => {
    const directory = await temporaryMigrations(
      "-- SPDX-License-Identifier: Apache-2.0\nSELECT 1;",
    );
    const driver = new FakePostgresDriver();

    expect(
      await migrate(driver, "postgres", { migrationDirectory: directory, dryRun: true }),
    ).toEqual(["0001"]);
    expect(driver.historyTable).toBe(false);
    expect(
      await migrate(driver, "postgres", { migrationDirectory: directory, appliedAt: 1 }),
    ).toEqual(["0001"]);
    expect(
      await migrate(driver, "postgres", { migrationDirectory: directory, appliedAt: 2 }),
    ).toEqual([]);
    expect(driver.statements).toHaveLength(1);
    expect(driver.history.size).toBe(1);
  });

  it("rejects edited SQL and newer database versions", async () => {
    const directory = await temporaryMigrations(
      "-- SPDX-License-Identifier: Apache-2.0\nSELECT 1;",
    );
    const driver = new FakePostgresDriver();
    await migrate(driver, "postgres", { migrationDirectory: directory });
    await writeFile(
      join(directory, "0001_init.sql"),
      "-- SPDX-License-Identifier: Apache-2.0\nSELECT 2;",
    );
    await expect(
      migrate(driver, "postgres", { migrationDirectory: directory }),
    ).rejects.toMatchObject({
      code: "migration_checksum_mismatch",
    });

    const newerDriver = new FakePostgresDriver();
    newerDriver.history.set("9999_future", "synthetic-checksum");
    await expect(
      migrate(newerDriver, "postgres", { migrationDirectory: directory }),
    ).rejects.toMatchObject({
      code: "schema_newer_than_code",
    });
  });

  it("rolls back a failed migration transaction", async () => {
    const directory = await temporaryMigrations("-- SPDX-License-Identifier: Apache-2.0\nFAIL;");
    const driver = new FakePostgresDriver();

    await expect(migrate(driver, "postgres", { migrationDirectory: directory })).rejects.toThrow(
      "Synthetic migration failure",
    );
    expect(driver.historyTable).toBe(false);
    expect(driver.history.size).toBe(0);
  });
});
