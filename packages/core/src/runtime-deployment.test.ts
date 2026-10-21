// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Id,
  RunConfigSchema,
  SecretRefSchema,
  VaultConfigSchema,
  FakeClock,
  SequentialIdGenerator,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { openSqliteInstanceHeartbeat } from "@harness/store-sqlite";
import { DeploymentStartupError, validateDeploymentTopology } from "./runtime-deployment.js";
import { createRuntime } from "./runtime.js";

function instanceCount(databasePath: string): number {
  const database = new Database(`${databasePath}.instances`);
  try {
    const row = database.prepare("SELECT COUNT(*) AS count FROM instances").get();
    return typeof row === "object" && row !== null && "count" in row
      ? Number(row.count)
      : 0;
  } finally {
    database.close();
  }
}

const postgresVault = VaultConfigSchema.parse({
  backend: "postgres",
  postgres: { url: "env:TEST_VAULT_URL" },
});
const sqliteVault = VaultConfigSchema.parse({ backend: "sqlite" });

describe("validateDeploymentTopology", () => {
  const cases: readonly {
    readonly config: Parameters<typeof validateDeploymentTopology>[0];
    readonly supported: boolean;
  }[] = [
    { config: {}, supported: true },
    { config: { deployment: { mode: "single" } }, supported: true },
    {
      config: {
        deployment: { mode: "multi" },
        store: { dialect: "postgres" },
        vault: postgresVault,
      },
      supported: true,
    },
    {
      config: {
        deployment: { mode: "multi" },
        store: { dialect: "sqlite" },
        vault: postgresVault,
      },
      supported: false,
    },
    {
      config: {
        deployment: { mode: "multi" },
        store: { dialect: "postgres" },
        vault: sqliteVault,
      },
      supported: false,
    },
    { config: { deployment: { mode: "multi" } }, supported: false },
  ];

  it.each(cases)("validates topology $config", ({ config, supported }) => {
    if (supported) {
      expect(() =>
        validateDeploymentTopology(config, config.deployment?.mode === "multi"),
      ).not.toThrow();
    } else {
      expect(() =>
        validateDeploymentTopology(config, config.store?.dialect === "postgres"),
      ).toThrow(expect.objectContaining({ code: "deployment_requires_postgres" }));
    }
  });

  describe("single-instance SQLite ownership", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("creates a heartbeat sidecar for a SQLite vault when the event store is Postgres", async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "harness-mixed-store-vault-"));
      const config = {
        run: RunConfigSchema.parse({}),
        store: {
          dialect: "postgres" as const,
          connectionString: SecretRefSchema.parse("env:TEST_STORE_URL"),
        },
        vault: sqliteVault,
      };
      const overrides = {
        store: new InMemoryEventStore(),
        dataDir,
        clock: new FakeClock(100),
        ids: new SequentialIdGenerator(),
      };
      const first = await createRuntime(config, overrides);
      try {
        expect(existsSync(join(dataDir, "vault.db.instances"))).toBe(true);
        expect(existsSync(join(dataDir, "harness.db.instances"))).toBe(false);
      } finally {
        await first.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });

    it("shares the vault heartbeat across runtimes with separate event directories", async () => {
      const firstDataDir = await mkdtemp(join(tmpdir(), "harness-shared-vault-first-"));
      const secondDataDir = await mkdtemp(join(tmpdir(), "harness-shared-vault-second-"));
      const vaultDataDir = await mkdtemp(join(tmpdir(), "harness-shared-vault-"));
      vi.stubEnv("HARNESS_VAULT_DATA_DIR", vaultDataDir);
      const config = { run: RunConfigSchema.parse({}), vault: sqliteVault };
      const first = await createRuntime(config, {
        dataDir: firstDataDir,
        clock: new FakeClock(100),
        ids: new SequentialIdGenerator(),
      });
      let second: Awaited<ReturnType<typeof createRuntime>> | undefined;
      try {
        second = await createRuntime(config, {
            dataDir: secondDataDir,
            clock: new FakeClock(100),
            ids: new SequentialIdGenerator(),
          });
        expect(instanceCount(join(firstDataDir, "harness.db"))).toBe(1);
        expect(instanceCount(join(secondDataDir, "harness.db"))).toBe(1);
        expect(instanceCount(join(vaultDataDir, "vault.db"))).toBe(1);
      } finally {
        await second?.close();
        await first.close();
        await Promise.all([
          rm(firstDataDir, { recursive: true, force: true }),
          rm(secondDataDir, { recursive: true, force: true }),
          rm(vaultDataDir, { recursive: true, force: true }),
        ]);
      }
    });

    it("stops a runtime before it can write after its SQLite heartbeat is taken over", async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "harness-heartbeat-fence-"));
      const runtime = await createRuntime(
        { run: RunConfigSchema.parse({}) },
        { dataDir, clock: new FakeClock(100), ids: new SequentialIdGenerator() },
      );
      const heartbeat = await openSqliteInstanceHeartbeat({
        databasePath: join(dataDir, "harness.db"),
        instanceId: Id.parse("00000000000000000000000002"),
        now: () => 100,
      });
      const database = new Database(join(dataDir, "harness.db.instances"));
      database.prepare("UPDATE instances SET id = ?").run("00000000000000000000000003");
      database.close();

      try {
        expect(() => heartbeat?.heartbeat()).toThrow();
        await expect(runtime.run("must not be recorded")).rejects.toMatchObject({
          code: "deployment_single_instance_violation",
        });
      } finally {
        await heartbeat?.close();
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  it("requires a durable queue for multi-instance mode", () => {
    expect(() =>
      validateDeploymentTopology({
        deployment: { mode: "multi" },
        store: { dialect: "postgres" },
        vault: postgresVault,
      }),
    ).toThrow(expect.objectContaining({ code: "deployment_requires_postgres" }));
  });

  it("provides a typed refusal for a second live SQLite instance", () => {
    expect(new DeploymentStartupError("deployment_single_instance_violation")).toMatchObject({
      code: "deployment_single_instance_violation",
    });
  });
});
