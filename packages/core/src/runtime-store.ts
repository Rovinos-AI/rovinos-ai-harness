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
import type { SecretRef, StoreConfig } from "@harness/schemas";
import { resolveDataDir } from "./runtime-data-dir.js";

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
