// SPDX-License-Identifier: Apache-2.0
import { CompositeSecretResolver, EnvSecretResolver, FileSecretResolver } from "@harness/config";
import {
  HarnessError,
  StoreMigrateResultSchema,
  StorePurgeResultSchema,
  type Id as RunId,
} from "@harness/schemas";
import type { HarnessConfig } from "@harness/config";
import type { EventStore } from "@harness/store";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CliContext, CommandModule } from "../command.js";

interface StoreCommandOperations {
  migrate(
    config: HarnessConfig,
    databasePath: string,
    dryRun: boolean,
    appliedAt: number,
  ): Promise<string[]>;
  openStore(config: HarnessConfig, databasePath: string, dryRun: boolean): Promise<EventStore>;
}

class StoreCommandError extends HarnessError {
  override readonly code: "retention_not_configured" | "retention_hook_failed";

  constructor(code: "retention_not_configured" | "retention_hook_failed") {
    super(code);
    this.code = code;
  }
}

class StoreConfigError extends HarnessError {
  override readonly code = "config_invalid";

  constructor() {
    super("The configured Postgres connection reference is unavailable.");
  }
}

interface StoreCommandInput {
  context: CliContext;
  config: HarnessConfig;
  databasePath: string;
  dryRun: boolean;
  jsonMode: boolean;
  operations: StoreCommandOperations;
}

function isVaultPurger(value: unknown): value is { purge(runId: RunId): Promise<unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "purge" in value &&
    typeof value.purge === "function"
  );
}

async function postgresConnectionString(config: HarnessConfig): Promise<string> {
  const reference = config.store.connectionString;
  if (reference === undefined) {
    throw new StoreConfigError();
  }
  const resolver = new CompositeSecretResolver({
    env: new EnvSecretResolver(process.env),
    file: new FileSecretResolver(),
  });
  return (await resolver.resolve(reference)).reveal();
}

const defaultOperations: StoreCommandOperations = {
  async migrate(config, databasePath, dryRun, appliedAt) {
    const store = await import("@harness/store");
    if (config.store.dialect === "postgres") {
      const connectionString = await postgresConnectionString(config);
      return store.migratePostgresConnection(connectionString, { dryRun, appliedAt });
    }
    return store.migrateSqliteFile(databasePath, { dryRun, appliedAt });
  },
  async openStore(config, databasePath, dryRun) {
    const store = await import("@harness/store");
    if (config.store.dialect === "postgres") {
      const connectionString = await postgresConnectionString(config);
      return new store.PostgresEventStore(connectionString, { skipMigrations: dryRun });
    }
    if (dryRun) {
      const { existsSync } = await import("node:fs");
      return existsSync(databasePath)
        ? new store.SqliteEventStore(databasePath, undefined, { readOnly: true })
        : new store.InMemoryEventStore();
    }
    const core = await import("@harness/core");
    await mkdir(core.resolveDataDir(process.env), { recursive: true });
    return new store.SqliteEventStore(databasePath);
  },
};

async function writeMigrateResult({
  context,
  config,
  databasePath,
  dryRun,
  jsonMode,
  operations,
}: StoreCommandInput): Promise<void> {
  const versions = await operations.migrate(config, databasePath, dryRun, context.clock.now());
  const result = {
    applied: dryRun ? [] : versions,
    pending: dryRun ? versions : [],
  };
  context.out.json(StoreMigrateResultSchema, result);
  if (!jsonMode) {
    if (dryRun) {
      context.out.print(
        versions.length === 0
          ? "No pending migrations.\n"
          : `Pending migrations: ${versions.join(", ")}\n`,
      );
    } else {
      context.out.print(
        versions.length === 0
          ? "No migrations applied.\n"
          : `Applied migrations: ${versions.join(", ")}\n`,
      );
    }
  }
}

async function writePurgeResult({
  context,
  config,
  databasePath,
  dryRun,
  jsonMode,
  operations,
}: StoreCommandInput): Promise<void> {
  const policy = config.store.retention;
  if (policy === undefined) {
    throw new StoreCommandError("retention_not_configured");
  }
  const store = await operations.openStore(config, databasePath, dryRun);
  try {
    const vault = await context.createVaultResolver?.(config);
    const { purgeExpiredRuns } = await import("@harness/store");
    const result = await purgeExpiredRuns({
      store,
      clock: context.clock,
      policy,
      dryRun,
      ...(isVaultPurger(vault)
        ? {
            onRunPurged: async (runId: string) => {
              await vault.purge(runId);
            },
          }
        : {}),
    });
    context.out.json(StorePurgeResultSchema, result);
    if (!jsonMode) {
      context.out.table([
        ["examined", "purged", "skippedActive", "hookFailures"],
        [result.examined, result.purged, result.skippedActive, result.hookFailures],
      ]);
    }
    if (result.hookFailures > 0) {
      throw new StoreCommandError("retention_hook_failed");
    }
  } finally {
    await store.close();
  }
}

/**
 * Creates the `harness store` command group.
 *
 * @param operations - Optional store operations for deterministic command tests.
 * @returns A command module that applies migrations and purges expired runs.
 */
export function createStoreCommand(
  operations: StoreCommandOperations = defaultOperations,
): CommandModule {
  return {
    name: "store",
    register(program, context) {
      const store = program.command("store").description("Manage the event store");
      store
        .command("migrate")
        .description("Apply or list pending store schema migrations")
        .option("--dry-run", "list pending migrations without applying them")
        .action(async (options: { readonly dryRun?: boolean }) => {
          const config = await context.loadConfig();
          const core = await import("@harness/core");
          const databasePath = join(core.resolveDataDir(process.env), "harness.db");
          await writeMigrateResult({
            context,
            config,
            databasePath,
            dryRun: options.dryRun === true,
            jsonMode: program.opts<{ json?: boolean }>().json === true,
            operations,
          });
        });
      store
        .command("purge")
        .description("Purge expired terminal runs using the configured retention windows")
        .option("--dry-run", "count eligible runs without deleting them")
        .action(async (options: { readonly dryRun?: boolean }) => {
          const config = await context.loadConfig();
          const core = await import("@harness/core");
          const databasePath = join(core.resolveDataDir(process.env), "harness.db");
          await writePurgeResult({
            context,
            config,
            databasePath,
            dryRun: options.dryRun === true,
            jsonMode: program.opts<{ json?: boolean }>().json === true,
            operations,
          });
        });
    },
  };
}

/** The default `harness store` command module. */
export const storeCommand = createStoreCommand();
