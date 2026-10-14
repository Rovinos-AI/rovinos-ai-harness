// SPDX-License-Identifier: Apache-2.0
import { CompositeSecretResolver, HarnessConfigSchema } from "@harness/config";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeClock,
  StoreMigrateResultSchema,
  StorePurgeResultSchema,
  parseJson,
  type RunStatus,
} from "@harness/schemas";
import { InMemoryEventStore, StoreMigrationError } from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import { InMemoryVault } from "@harness/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { createStoreCommand } from "./store.js";

const DAY_MS = 86_400_000;
const builders = createEventBuilders();
const postgresState = vi.hoisted(() => ({ ended: false, queries: new Array<string>() }));
let temporaryDirectory: string | undefined;

vi.mock("pg", () => ({
  Pool: class {
    on(): this {
      return this;
    }

    query(query: string): Promise<{ rows: Record<string, unknown>[] }> {
      postgresState.queries.push(query);
      return Promise.resolve({ rows: [{ present: false }] });
    }

    connect(): Promise<never> {
      return Promise.reject(new Error("unexpected transaction"));
    }

    end(): Promise<void> {
      postgresState.ended = true;
      return Promise.resolve();
    }
  },
}));

function createContext(
  harnessConfig: ReturnType<typeof HarnessConfigSchema.parse>,
  options: { readonly now?: number; readonly vault?: CliContext["createVaultResolver"] } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: () => Promise.resolve(harnessConfig),
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: new FakeClock(options.now ?? 10 * DAY_MS),
    secretResolver: new CompositeSecretResolver(),
    ...(options.vault === undefined ? {} : { createVaultResolver: options.vault }),
  };
  return { context, stdout, stderr };
}

function config(retention = true) {
  return HarnessConfigSchema.parse({
    store: retention ? { retention: { completedRunsDays: 1, failedRunsDays: 1 } } : {},
  });
}

function postgresConfig() {
  return HarnessConfigSchema.parse({
    store: {
      dialect: "postgres",
      connectionString: "env:HARNESS_STORE_MIGRATION_TEST_URL",
    },
  });
}

function postgresRetentionConfig() {
  return HarnessConfigSchema.parse({
    store: {
      ...postgresConfig().store,
      retention: { completedRunsDays: 1, failedRunsDays: 1 },
    },
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

async function seedRun(store: InMemoryEventStore, status: RunStatus, lastTs: number) {
  const runId = builders.nextRunId();
  const created = { ...builders.runCreated(runId), ts: lastTs - 1 };
  await store.append(
    runId,
    status === "pending"
      ? [created]
      : [created, { ...builders.runStatusChanged(runId, "pending", status), ts: lastTs }],
    0,
  );
  return runId;
}

describe("harness store migrate", () => {
  it("uses SQLite by default and keeps dry runs from creating the database", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-store-cli-"));
    const dataDirectory = join(temporaryDirectory, "data");
    const databasePath = join(dataDirectory, "harness.db");
    vi.stubEnv("HARNESS_DATA_DIR", dataDirectory);
    const { context: dryContext, stdout: dryStdout } = createContext(config());

    const dryExitCode = await main(["store", "migrate", "--dry-run", "--json"], dryContext, [
      createStoreCommand(),
    ]);

    expect(dryExitCode).toBe(ExitCode.ok);
    expect(parseJson(StoreMigrateResultSchema, dryStdout[0] ?? "")).toEqual({
      applied: [],
      pending: ["0001", "0002", "0003"],
    });
    expect(existsSync(databasePath)).toBe(false);

    const { context: applyContext, stdout: applyStdout } = createContext(config());
    const applyExitCode = await main(["--json", "store", "migrate"], applyContext, [
      createStoreCommand(),
    ]);
    expect(applyExitCode).toBe(ExitCode.ok);
    expect(parseJson(StoreMigrateResultSchema, applyStdout[0] ?? "")).toEqual({
      applied: ["0001", "0002", "0003"],
      pending: [],
    });

    const { context: repeatApplyContext, stdout: repeatApplyStdout } = createContext(config());
    const repeatApplyExitCode = await main(["store", "migrate"], repeatApplyContext, [
      createStoreCommand(),
    ]);
    expect(repeatApplyExitCode).toBe(ExitCode.ok);
    expect(repeatApplyStdout).toEqual(["No migrations applied.\n"]);

    const { context: noPendingContext, stdout: noPendingStdout } = createContext(config());
    const noPendingExitCode = await main(["store", "migrate", "--dry-run"], noPendingContext, [
      createStoreCommand(),
    ]);
    expect(noPendingExitCode).toBe(ExitCode.ok);
    expect(noPendingStdout).toEqual(["No pending migrations.\n"]);

    const { context: purgeDryContext, stdout: purgeDryStdout } = createContext(config());
    const purgeDryExitCode = await main(
      ["--json", "store", "purge", "--dry-run"],
      purgeDryContext,
      [createStoreCommand()],
    );
    expect(purgeDryExitCode).toBe(ExitCode.ok);
    expect(parseJson(StorePurgeResultSchema, purgeDryStdout[0] ?? "")).toMatchObject({
      examined: 0,
      purged: 0,
    });

    const { context: purgeContext, stdout: purgeStdout } = createContext(config());
    const purgeExitCode = await main(["--json", "store", "purge"], purgeContext, [
      createStoreCommand(),
    ]);
    expect(purgeExitCode).toBe(ExitCode.ok);
    expect(parseJson(StorePurgeResultSchema, purgeStdout[0] ?? "")).toMatchObject({
      examined: 0,
      purged: 0,
    });
  });

  it("runs the default Postgres migration path using the configured secret reference", async () => {
    vi.stubEnv("HARNESS_STORE_MIGRATION_TEST_URL", "postgresql://synthetic@localhost/harness");
    postgresState.ended = false;
    postgresState.queries = [];
    const { context, stdout, stderr } = createContext(postgresConfig());

    const exitCode = await main(["--json", "store", "migrate", "--dry-run"], context, [
      createStoreCommand(),
    ]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(parseJson(StoreMigrateResultSchema, stdout[0] ?? "")).toEqual({
      applied: [],
      pending: ["0001", "0002", "0003"],
    });
    expect(postgresState.queries).toEqual([
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    ]);
    expect(postgresState.ended).toBe(true);
    expect(stderr).toEqual([]);
  });

  it("reports pending versions as one JSON document in dry-run mode", async () => {
    const { context, stdout, stderr } = createContext(config());
    const migrate = vi.fn(() => Promise.resolve(["0001", "0002"]));

    const exitCode = await main(["--json", "store", "migrate", "--dry-run"], context, [
      createStoreCommand({ migrate, openStore: vi.fn() }),
    ]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(parseJson(StoreMigrateResultSchema, stdout[0] ?? "")).toEqual({
      applied: [],
      pending: ["0001", "0002"],
    });
    expect(migrate).toHaveBeenCalledWith(config(), true, 10 * DAY_MS, expect.any(Object));
    expect(stderr).toEqual([]);
  });

  it("applies pending migrations and prints a concise human result", async () => {
    const { context, stdout, stderr } = createContext(config());

    const exitCode = await main(["store", "migrate"], context, [
      createStoreCommand({
        migrate: () => Promise.resolve(["0001"]),
        openStore: vi.fn(),
      }),
    ]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(stdout).toEqual(["Applied migrations: 0001\n"]);
    expect(stderr).toEqual([]);
  });

  it.each([
    "migration_checksum_mismatch",
    "schema_newer_than_code",
    "migration_set_invalid",
    "schema_migration_pending",
  ] as const)("reports %s without exposing the error message", async (code) => {
    const { context, stdout, stderr } = createContext(config());
    const command = createStoreCommand({
      migrate: () => Promise.reject(new StoreMigrationError(code)),
      openStore: vi.fn(),
    });

    const exitCode = await main(["--json", "store", "migrate"], context, [command]);

    expect(exitCode).toBe(ExitCode.failure);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([`${code}\n`]);
  });
});

describe("harness store purge", () => {
  it("prints purge counts in human-readable mode", async () => {
    const store = new InMemoryEventStore();
    const { context, stdout, stderr } = createContext(config());

    const exitCode = await main(["store", "purge"], context, [
      createStoreCommand({
        migrate: vi.fn(),
        openStore: () => Promise.resolve(store),
      }),
    ]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(stdout).toEqual(["examined\tpurged\tskippedActive\thookFailures\n0\t0\t0\t0\n"]);
    expect(stderr).toEqual([]);
  });

  it("does not apply pending Postgres migrations during a purge dry run", async () => {
    vi.stubEnv("HARNESS_STORE_MIGRATION_TEST_URL", "postgresql://synthetic@localhost/harness");
    postgresState.ended = false;
    postgresState.queries = [];
    const { context, stdout, stderr } = createContext(postgresRetentionConfig());

    const exitCode = await main(["--json", "store", "purge", "--dry-run"], context, [
      createStoreCommand(),
    ]);

    expect(exitCode).toBe(ExitCode.failure);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["schema_migration_pending\n"]);
    expect(postgresState.queries).toEqual([
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    ]);
    expect(postgresState.ended).toBe(true);
  });

  it("reports dry-run counts and leaves the store unchanged", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "completed", 1);
    const before = await store.listRuns({ limit: 10 });
    const { context, stdout, stderr } = createContext(config(), { now: 3 * DAY_MS });
    const command = createStoreCommand({
      migrate: vi.fn(),
      openStore: () => Promise.resolve(store),
    });

    const exitCode = await main(["--json", "store", "purge", "--dry-run"], context, [command]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(parseJson(StorePurgeResultSchema, stdout[0] ?? "")).toEqual({
      examined: 1,
      purged: 1,
      skippedActive: 0,
      hookFailures: 0,
    });
    await expect(store.listRuns({ limit: 10 })).resolves.toEqual(before);
    expect(stderr).toEqual([]);
  });

  it("purges vault mappings immediately when the retention hook deletes a run", async () => {
    const store = new InMemoryEventStore();
    const runId = await seedRun(store, "completed", 1);
    const vault = new InMemoryVault();
    const token = await vault.put(runId, "email", "alice@example.test");
    const closeVault = vi.fn();
    const vaultAdmin = Object.assign(vault, { close: closeVault });
    const { context, stdout, stderr } = createContext(config(), { now: 3 * DAY_MS });
    const command = createStoreCommand({
      migrate: vi.fn(),
      openStore: () => Promise.resolve(store),
      openVaultAdmin: () => Promise.resolve(vaultAdmin),
    });

    const exitCode = await main(["--json", "store", "purge"], context, [command]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(parseJson(StorePurgeResultSchema, stdout[0] ?? "")).toMatchObject({
      purged: 1,
      hookFailures: 0,
    });
    await expect(vault.resolve(runId, token, { boundary: "ui" })).resolves.toBeUndefined();
    expect(closeVault).toHaveBeenCalledOnce();
    expect(stderr).toEqual([]);
  });

  it("reports terminal vault purge counts in JSON and table output", async () => {
    const store = new InMemoryEventStore();
    const runId = await seedRun(store, "completed", 10 * DAY_MS);
    const vault = new InMemoryVault();
    await vault.put(runId, "email", "alice@example.test");
    await vault.markTerminal(runId, 1);
    const vaultAdmin = Object.assign(vault, { close: vi.fn() });
    const { context, stdout, stderr } = createContext(config(), { now: 10 * DAY_MS });
    const command = createStoreCommand({
      migrate: vi.fn(),
      openStore: () => Promise.resolve(store),
      openVaultAdmin: () => Promise.resolve(vaultAdmin),
    });

    const exitCode = await main(["--json", "store", "purge"], context, [command]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(parseJson(StorePurgeResultSchema, stdout[0] ?? "")).toEqual({
      examined: 1,
      purged: 0,
      skippedActive: 0,
      hookFailures: 0,
      vault: { examined: 1, purged: 1, entriesPurged: 1 },
    });
    expect(stderr).toEqual([]);
    expect(vaultAdmin.close).toHaveBeenCalledOnce();
  });

  it("prints terminal vault purge counts in human-readable mode", async () => {
    const store = new InMemoryEventStore();
    const runId = await seedRun(store, "completed", 10 * DAY_MS);
    const vault = new InMemoryVault();
    await vault.put(runId, "email", "alice@example.test");
    await vault.markTerminal(runId, 1);
    const vaultAdmin = Object.assign(vault, { close: vi.fn() });
    const { context, stdout, stderr } = createContext(config(), { now: 10 * DAY_MS });
    const command = createStoreCommand({
      migrate: vi.fn(),
      openStore: () => Promise.resolve(store),
      openVaultAdmin: () => Promise.resolve(vaultAdmin),
    });

    const exitCode = await main(["store", "purge"], context, [command]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(stdout).toEqual([
      "examined\tpurged\tskippedActive\thookFailures\tvault.examined\tvault.purged\tvault.entriesPurged\n1\t0\t0\t0\t1\t1\t1\n",
    ]);
    expect(stderr).toEqual([]);
  });

  it("counts a failed vault retention hook in the purge result", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "completed", 1);
    const vaultAdmin = {
      markTerminal: () => Promise.resolve(),
      listTerminalRunsBefore: () => Promise.resolve([]),
      purge: () => Promise.reject(new Error("synthetic hook failure")),
      stats: () => Promise.resolve({ entries: 0 }),
      close: vi.fn(),
    };
    const { context, stdout, stderr } = createContext(config(), { now: 3 * DAY_MS });
    const command = createStoreCommand({
      migrate: vi.fn(),
      openStore: () => Promise.resolve(store),
      openVaultAdmin: () => Promise.resolve(vaultAdmin),
    });

    const exitCode = await main(["--json", "store", "purge"], context, [command]);

    expect(exitCode).toBe(ExitCode.failure);
    expect(parseJson(StorePurgeResultSchema, stdout[0] ?? "")).toEqual({
      examined: 1,
      purged: 1,
      skippedActive: 0,
      hookFailures: 1,
      vault: { examined: 0, purged: 0, entriesPurged: 0 },
    });
    expect(stderr).toEqual(["retention_hook_failed\n"]);
  });

  it("requires configured retention before opening the store", async () => {
    const { context, stdout, stderr } = createContext(config(false));
    const openStore = vi.fn();

    const exitCode = await main(["--json", "store", "purge"], context, [
      createStoreCommand({ migrate: vi.fn(), openStore }),
    ]);

    expect(exitCode).toBe(ExitCode.failure);
    expect(openStore).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["retention_not_configured\n"]);
  });

  it("does not construct the vault while the separately typed purge hook is not wired", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "completed", 1);
    const createVaultResolver = vi.fn(() => Promise.resolve(undefined));
    const { context, stdout, stderr } = createContext(config(), {
      now: 3 * DAY_MS,
      vault: createVaultResolver,
    });
    const command = createStoreCommand({
      migrate: vi.fn(),
      openStore: () => Promise.resolve(store),
    });

    const exitCode = await main(["--json", "store", "purge", "--dry-run"], context, [command]);
    const result = parseJson(StorePurgeResultSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.ok);
    expect(result).toMatchObject({ purged: 1, hookFailures: 0 });
    expect(createVaultResolver).not.toHaveBeenCalled();
    expect(stderr).toEqual([]);
  });
});
