// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@rovinos/config";
import { FakeClock, StoreMigrateResultSchema, parseJson } from "@rovinos/schemas";
import { migrate } from "@rovinos/store/adapter-internal";
import { PostgresEventStore } from "@rovinos/store-postgres";
import { createEventBuilders } from "@rovinos/store/testing";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStoreCommand } from "./store.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";

// Derived from the store's migration files so adding a migration does not break this assertion.
const postgresMigrationVersions = (
  await readdir(new URL("../../../store-postgres/migrations/postgres/", import.meta.url))
)
  .filter((file) => file.endsWith(".sql"))
  .map((file) => file.slice(0, 4))
  .sort();
import { main } from "../main.js";

const connectionString = process.env.TEST_POSTGRES_URL ?? "";

describe.skipIf(connectionString.length === 0)("store maintenance with Postgres", () => {
  it("keeps pending migrations and runs unchanged for both dry-run commands", async () => {
    const schema = `t_${randomUUID().replaceAll("-", "")}`;
    const runId = createEventBuilders().nextRunId();
    const pool = new Pool({
      connectionString,
      options: `-c search_path="${schema}"`,
    });
    const admin = new Pool({ connectionString });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(
        `CREATE TABLE "${schema}".schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)`,
      );
      await admin.query(
        `CREATE TABLE "${schema}".runs (run_id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, status TEXT NOT NULL, next_seq BIGINT NOT NULL, last_ts BIGINT NOT NULL)`,
      );
      await admin.query(
        `INSERT INTO "${schema}".runs (run_id, created_at, status, next_seq, last_ts) VALUES ($1, $2, $3, $4, $5)`,
        [runId, 1, "completed", 1, 1],
      );

      const config = HarnessConfigSchema.parse({
        store: {
          dialect: "postgres",
          connectionString: "env:TEST_POSTGRES_URL",
          retention: { completedRunsDays: 1, failedRunsDays: 1 },
        },
      });
      const stdout: string[] = [];
      const stderr: string[] = [];
      const context = {
        loadConfig: () => Promise.resolve(config),
        out: createOutput({
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        }),
        clock: new FakeClock(3 * 86_400_000),
      };
      const command = createStoreCommand({
        migrate: (_config, dryRun, appliedAt) =>
          migrate(pool, "postgres", {
            dryRun,
            appliedAt,
            migrationDirectory: fileURLToPath(
              new URL("../../../store-postgres/migrations/postgres/", import.meta.url),
            ),
          }),
        openStore: (_config, dryRun) =>
          Promise.resolve(
            new PostgresEventStore(connectionString, { schema, skipMigrations: dryRun }),
          ),
      });

      const migrateExitCode = await main(["--json", "store", "migrate", "--dry-run"], context, [
        command,
      ]);
      expect(migrateExitCode).toBe(ExitCode.ok);
      expect(parseJson(StoreMigrateResultSchema, stdout[0] ?? "")).toEqual({
        applied: [],
        pending: postgresMigrationVersions,
      });

      stdout.length = 0;
      const purgeExitCode = await main(["--json", "store", "purge", "--dry-run"], context, [
        command,
      ]);
      expect(purgeExitCode).toBe(ExitCode.failure);
      expect(stderr).toEqual(["schema_migration_pending\n"]);

      const history = await admin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".schema_migrations`,
      );
      const runs = await admin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".runs`,
      );
      expect(history.rows[0]?.count).toBe("0");
      expect(runs.rows[0]?.count).toBe("1");
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
