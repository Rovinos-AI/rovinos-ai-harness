// SPDX-License-Identifier: Apache-2.0
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AesGcmContentCodec,
  InMemoryEventStore,
  migratePostgresConnection,
  migrateSqliteFile,
  PostgresEventStore,
  SqliteEventStore,
  StoreUnavailableError,
  type Clock,
  type EventStore,
  type StoreKeyRotation,
} from "@harness/store";
import {
  InMemoryVault,
  PostgresVault,
  SqliteVault,
  VaultOperationError,
  type VaultAdmin,
  type VaultTerminalRunsQuery,
  type VaultKeyRotation,
} from "@harness/vault";
import type { Id, KeysConfig, SecretRef, StoreConfig, VaultConfig } from "@harness/schemas";
import type { RuntimeOverrides } from "./runtime-config.js";
import { resolveDataDir, resolveVaultDataDir } from "./runtime-data-dir.js";
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

async function openConfiguredRotationStore(
  config: { readonly store?: StoreConfig },
  options: ConfiguredKeyRotationOptions,
  keys: Awaited<ReturnType<typeof createRuntimeKeys>>,
  openedStores: (SqliteEventStore | PostgresEventStore)[],
): Promise<ConfiguredKeyRotation["store"]> {
  const storeConfig = config.store ?? {};
  const codec = new AesGcmContentCodec(keys);
  if (storeConfig.dialect === "postgres") {
    const connectionString = await postgresConnectionString(storeConfig, options.secretResolver);
    const opened = new PostgresEventStore(
      connectionString,
      {
        ...(storeConfig.snapshotKeep === undefined
          ? {}
          : { snapshotKeep: storeConfig.snapshotKeep }),
      },
      codec,
      options.clock ?? { now: () => Date.now() },
    );
    openedStores.push(opened);
    return opened;
  }

  const databasePath = join(resolveDataDir(process.env, options.dataDir), "harness.db");
  if (existsSync(databasePath)) {
    const opened = new SqliteEventStore(
      databasePath,
      codec,
      storeConfig.snapshotKeep === undefined ? {} : { snapshotKeep: storeConfig.snapshotKeep },
    );
    openedStores.push(opened);
    return opened;
  }
  return {
    reencryptBatch: () => Promise.resolve({ processed: 0 }),
    countRowsByKey: () => Promise.resolve([]),
    close: () => Promise.resolve(),
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
  close(): void | Promise<void>;
}

/** Opened rotation adapters and the key provider they share. */
export interface ConfiguredKeyRotation {
  /** The configured current key id used for new writes. */
  readonly currentKeyId: string;
  /** Selected dedicated vault adapter, when requested. */
  readonly vault?: VaultKeyRotation & { close(): void | Promise<void> };
  /** Selected event-store adapter, when requested. */
  readonly store?: StoreKeyRotation & { close(): Promise<void> };
  /** Close opened databases and zero cached key material. */
  close(): Promise<void>;
}

/** Selects which configured stores to open for key rotation maintenance. */
export interface ConfiguredKeyRotationOptions extends ConfiguredStoreOptions {
  readonly vault: boolean;
  readonly store: boolean;
}

/**
 * Opens selected configured stores with their old-key read paths for rotation.
 *
 * @param config Validated key and event-store configuration.
 * @param options Store selection, data directory, and secret resolver.
 * @returns Rotation adapters and a resource cleanup function.
 */
export async function openConfiguredKeyRotation(
  config: {
    readonly keys?: KeysConfig | undefined;
    readonly store?: StoreConfig;
    readonly vault?: VaultConfig;
  },
  options: ConfiguredKeyRotationOptions,
): Promise<ConfiguredKeyRotation> {
  const keyOptions: RuntimeOverrides =
    options.secretResolver === undefined ? {} : { secretResolver: options.secretResolver };
  const keys = await createRuntimeKeys(config.keys, keyOptions);
  const openedVaults: (SqliteVault | PostgresVault)[] = [];
  const openedStores: (SqliteEventStore | PostgresEventStore)[] = [];
  try {
    let vault: ConfiguredKeyRotation["vault"];
    if (options.vault) {
      if (config.vault?.backend === "postgres") {
        const opened = await openConfiguredPostgresVault(config, options, keys);
        openedVaults.push(opened);
        vault = opened;
      } else {
        const dataDir = resolveVaultDataDir(
          process.env,
          resolveDataDir(process.env, options.dataDir),
        );
        const vaultPath = join(dataDir, "vault.db");
        if (existsSync(vaultPath)) {
          const opened = new SqliteVault(vaultPath, keys);
          openedVaults.push(opened);
          vault = opened;
        } else {
          vault = {
            reencryptBatch: () => Promise.resolve({ processed: 0 }),
            countRowsByKey: () => Promise.resolve([]),
            close: () => undefined,
          };
        }
      }
    }

    const store = options.store
      ? await openConfiguredRotationStore(config, options, keys, openedStores)
      : undefined;

    return {
      currentKeyId: keys.currentKeyId(),
      ...(vault === undefined ? {} : { vault }),
      ...(store === undefined ? {} : { store }),
      close: async () => {
        try {
          await Promise.all(openedStores.map((opened) => opened.close()));
        } finally {
          for (const opened of openedVaults) {
            await opened.close();
          }
          keys.dispose();
        }
      },
    };
  } catch (error) {
    await Promise.all(openedStores.map((opened) => opened.close().catch(() => undefined)));
    try {
      await Promise.all(
        openedVaults.map((opened) => Promise.resolve(opened.close()).catch(() => undefined)),
      );
    } finally {
      keys.dispose();
    }
    throw error;
  }
}

/** Opens the configured SQLite vault for retention maintenance. */
export async function openConfiguredVaultAdmin(
  config: {
    readonly keys?: KeysConfig | undefined;
    readonly vault?: VaultConfig;
    readonly store?: StoreConfig;
  },
  options: ConfiguredVaultOptions = {},
): Promise<ConfiguredVaultAdmin> {
  const keyOptions: RuntimeOverrides =
    options.secretResolver === undefined ? {} : { secretResolver: options.secretResolver };
  if (config.vault?.backend === "postgres") {
    const keys = await createRuntimeKeys(config.keys, keyOptions);
    let vault: PostgresVault | undefined;
    try {
      vault = await openConfiguredPostgresVault(config, options, keys);
      const openedVault = vault;
      return {
        markTerminal: (runId: Id, ts: number) => openedVault.markTerminal(runId, ts),
        listTerminalRunsBefore: (query: VaultTerminalRunsQuery) =>
          openedVault.listTerminalRunsBefore(query),
        purge: (runId: Id) => openedVault.purge(runId),
        stats: (runId: Id) => openedVault.stats(runId),
        close: async () => {
          try {
            await openedVault.close();
          } finally {
            keys.dispose();
          }
        },
      };
    } catch (error) {
      try {
        await vault?.close();
      } finally {
        keys.dispose();
      }
      if (error instanceof VaultOperationError) {
        throw error;
      }
      throw new VaultOperationError("vault_unavailable");
    }
  }
  const dataDir = resolveVaultDataDir(process.env, resolveDataDir(process.env, options.dataDir));
  const vaultPath = join(dataDir, "vault.db");
  if (!existsSync(vaultPath)) {
    return Object.assign(new InMemoryVault(), { close: () => undefined });
  }
  const keys = await createRuntimeKeys(config.keys, keyOptions);
  let vault: SqliteVault | undefined;
  try {
    const openedVault = new SqliteVault(vaultPath, keys, () => options.clock?.now() ?? Date.now());
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
    if (error instanceof VaultOperationError) {
      throw error;
    }
    throw new VaultOperationError("vault_unavailable");
  }
}

async function openConfiguredPostgresVault(
  config: {
    readonly vault?: VaultConfig;
    readonly store?: StoreConfig;
  },
  options: ConfiguredVaultOptions,
  keys: Awaited<ReturnType<typeof createRuntimeKeys>>,
): Promise<PostgresVault> {
  const vaultUrl = config.vault?.postgres?.url;
  const resolver = options.secretResolver;
  if (config.vault?.backend !== "postgres" || vaultUrl === undefined || resolver === undefined) {
    throw new VaultOperationError("vault_unavailable");
  }
  const vaultConnectionString = (await resolver.resolve(vaultUrl)).reveal();
  const storeConnectionString =
    config.store?.dialect === "postgres"
      ? await postgresConnectionString(config.store, resolver)
      : undefined;
  const vault = new PostgresVault(vaultConnectionString, keys, {
    ...(storeConnectionString === undefined ? {} : { storeConnectionString }),
    ...(options.clock === undefined ? {} : { now: () => options.clock?.now() ?? Date.now() }),
  });
  try {
    await vault.initialize();
    return vault;
  } catch (error) {
    await vault.close();
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
      ? new PostgresEventStore(connectionString, {
          skipMigrations: readOnly,
          ...(storeConfig.snapshotKeep === undefined
            ? {}
            : { snapshotKeep: storeConfig.snapshotKeep }),
        })
      : new PostgresEventStore(
          connectionString,
          {
            skipMigrations: readOnly,
            ...(storeConfig.snapshotKeep === undefined
              ? {}
              : { snapshotKeep: storeConfig.snapshotKeep }),
          },
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
  return new SqliteEventStore(databasePath, undefined, {
    readOnly,
    ...(storeConfig.snapshotKeep === undefined ? {} : { snapshotKeep: storeConfig.snapshotKeep }),
  });
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
