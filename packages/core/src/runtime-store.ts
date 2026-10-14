// SPDX-License-Identifier: Apache-2.0
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  InMemoryEventStore,
  migratePostgresConnection,
  migrateSqliteFile,
  PostgresEventStore,
  SqliteEventStore,
  StoreUnavailableError,
  type Clock,
  type EventStore,
} from "@harness/store";
import { SqliteVault, type VaultAdmin, type VaultTerminalRunsQuery } from "@harness/vault";
import type { Id, KeysConfig, SecretRef, StoreConfig } from "@harness/schemas";
import type { RuntimeOverrides } from "./runtime-config.js";
import { resolveDataDir } from "./runtime-data-dir.js";
import { createRuntimeKeys } from "./runtime-keys.js";

/** Inputs shared by runtime and CLI configured-store operations. */
export interface ConfiguredStoreOptions {
  readonly dataDir?: string;
  readonly readOnly?: boolean;
  readonly appliedAt?: number;
  readonly clock?: Clock;
  readonly secretResolver?: {
    resolve(ref: SecretRef): Promise<{ reveal(): string }>;
  };
}

/** Options for opening the configured vault for maintenance. */
export interface ConfiguredVaultOptions {
  readonly dataDir?: string;
  readonly clock?: Clock;
  readonly secretResolver?: {
    resolve(ref: SecretRef): Promise<{ reveal(): string }>;
  };
}

/** Vault administration handle with ownership of its SQLite and key resources. */
export interface ConfiguredVaultAdmin extends VaultAdmin {
  /** Close the vault database and dispose its cached keys. */
  close(): void;
}

/** Opens the configured SQLite vault for retention maintenance. */
export async function openConfiguredVaultAdmin(
  config: { readonly keys?: KeysConfig | undefined },
  options: ConfiguredVaultOptions = {},
): Promise<ConfiguredVaultAdmin> {
  const keyOptions: RuntimeOverrides =
    options.secretResolver === undefined ? {} : { secretResolver: options.secretResolver };
  const keys = await createRuntimeKeys(config.keys, keyOptions);
  let vault: SqliteVault | undefined;
  try {
    const dataDir = resolveDataDir(process.env, options.dataDir);
    await mkdir(dataDir, { recursive: true });
    const openedVault = new SqliteVault(
      join(dataDir, "vault.db"),
      keys,
      () => options.clock?.now() ?? Date.now(),
    );
    vault = openedVault;
    return {
      markTerminal: (runId: Id, ts: number) => openedVault.markTerminal(runId, ts),
      listTerminalRunsBefore: (query: VaultTerminalRunsQuery) =>
        openedVault.listTerminalRunsBefore(query),
      purge: (runId: Id) => openedVault.purge(runId),
      stats: (runId: Id) => openedVault.stats(runId),
      close: () => {
        try {
          openedVault.close();
        } finally {
          keys.dispose();
        }
      },
    };
  } catch (error) {
    try {
      vault?.close();
    } finally {
      keys.dispose();
    }
    throw error;
  }
}

/** Runtime store selection, including an optional embedding-provided store. */
export async function createRuntimeStore(
  config: { readonly store?: StoreConfig },
  overrides: RuntimeOverrides,
  clock: Clock,
): Promise<EventStore> {
  if (overrides.store !== undefined) {
    return overrides.store;
  }
  return openConfiguredStore(config, {
    clock,
    readOnly: overrides.readOnlyStore === true,
    ...(overrides.dataDir === undefined ? {} : { dataDir: overrides.dataDir }),
    ...(overrides.secretResolver === undefined ? {} : { secretResolver: overrides.secretResolver }),
  });
}

async function postgresConnectionString(
  config: StoreConfig,
  secretResolver: ConfiguredStoreOptions["secretResolver"],
): Promise<string> {
  if (config.connectionString === undefined || secretResolver === undefined) {
    throw new StoreUnavailableError();
  }
  return (await secretResolver.resolve(config.connectionString)).reveal();
}

/** Opens the configured event store shared by runtime and CLI maintenance commands. */
export async function openConfiguredStore(
  config: { readonly store?: StoreConfig },
  options: ConfiguredStoreOptions = {},
): Promise<EventStore> {
  const storeConfig = config.store ?? {};
  const readOnly = options.readOnly === true;
  if (storeConfig.dialect === "postgres") {
    const connectionString = await postgresConnectionString(storeConfig, options.secretResolver);
    return options.clock === undefined
      ? new PostgresEventStore(connectionString, { skipMigrations: readOnly })
      : new PostgresEventStore(
          connectionString,
          { skipMigrations: readOnly },
          undefined,
          options.clock,
        );
  }

  const databasePath = join(resolveDataDir(process.env, options.dataDir), "harness.db");
  if (readOnly && !existsSync(databasePath)) {
    return new InMemoryEventStore();
  }
  if (!readOnly) {
    await mkdir(resolveDataDir(process.env, options.dataDir), { recursive: true });
  }
  return new SqliteEventStore(databasePath, undefined, { readOnly });
}

/** Applies or lists migrations for the same configured store used at runtime. */
export async function migrateConfiguredStore(
  config: { readonly store?: StoreConfig },
  options: ConfiguredStoreOptions & { readonly dryRun?: boolean } = {},
): Promise<string[]> {
  const storeConfig = config.store ?? {};
  const migrationOptions = {
    dryRun: options.dryRun === true,
    ...(options.appliedAt === undefined ? {} : { appliedAt: options.appliedAt }),
  };
  if (storeConfig.dialect === "postgres") {
    return migratePostgresConnection(
      await postgresConnectionString(storeConfig, options.secretResolver),
      migrationOptions,
    );
  }
  const databasePath = join(resolveDataDir(process.env, options.dataDir), "harness.db");
  return migrateSqliteFile(databasePath, migrationOptions);
}
