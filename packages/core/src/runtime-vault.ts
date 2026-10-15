// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError, VaultConfigSchema } from "@harness/schemas";
import type { Id, SecretRef } from "@harness/schemas";
import { PostgresVault, SqliteVault, VaultOperationError } from "@harness/vault";
import type { TokenType, VaultTerminalRunsQuery } from "@harness/vault";
import type {
  RuntimeComposition,
  RuntimeConfig,
  RuntimeOverrides,
  RuntimeVault,
} from "./runtime-config.js";
import type { Clock } from "./recorder.js";
import { resolveVaultDataDir } from "./runtime-data-dir.js";

interface RuntimeVaultOptions {
  readonly dataDir: string;
  readonly config: RuntimeConfig;
  readonly overrides: RuntimeOverrides;
  readonly keys: RuntimeComposition["keys"];
  readonly clock: Clock;
}

class TransientVaultInProductionError extends HarnessError {
  readonly code = "transient_vault_in_production";

  constructor() {
    super("A transient vault cannot be used in production.");
  }
}

class EmptyReadOnlyVault implements RuntimeVault {
  private closed = false;

  put(): Promise<TokenType> {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }

  resolve(): Promise<string | undefined> {
    return this.closed
      ? Promise.reject(new VaultOperationError("vault_unavailable"))
      : Promise.resolve(undefined);
  }

  markTerminal(): Promise<void> {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }

  listTerminalRunsBefore(_query: VaultTerminalRunsQuery): Promise<readonly Id[]> {
    return Promise.resolve([]);
  }

  purge(): Promise<number> {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }

  stats(): Promise<{ entries: number }> {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }

  close(): void {
    this.closed = true;
  }
}

/** Opens the configured SQLite or shared Postgres vault and its owned resources. */
export async function createRuntimeVault(options: RuntimeVaultOptions): Promise<RuntimeVault> {
  const config = VaultConfigSchema.parse(options.config.vault ?? {});
  if (config.backend === "postgres") {
    return createPostgresVault(options, config.postgres?.url);
  }
  return createSqliteVault(options);
}

async function createPostgresVault(
  options: RuntimeVaultOptions,
  vaultUrl: SecretRef | undefined,
): Promise<PostgresVault> {
  const resolver = options.overrides.secretResolver;
  if (resolver === undefined || vaultUrl === undefined) {
    throw new VaultOperationError("vault_unavailable");
  }
  const vaultConnectionString = (await resolver.resolve(vaultUrl)).reveal();
  let storeConnectionString: string | undefined;
  if (options.config.store?.dialect === "postgres") {
    const storeUrl = options.config.store.connectionString;
    if (storeUrl === undefined) {
      throw new VaultOperationError("vault_unavailable");
    }
    storeConnectionString = (await resolver.resolve(storeUrl)).reveal();
  }
  const vault = new PostgresVault(vaultConnectionString, options.keys, {
    ...(storeConnectionString === undefined ? {} : { storeConnectionString }),
    now: () => options.clock.now(),
  });
  try {
    await vault.initialize();
    return vault;
  } catch (error) {
    await vault.close().catch(() => undefined);
    throw error;
  }
}

async function createSqliteVault(options: RuntimeVaultOptions): Promise<RuntimeVault> {
  const vaultDir = resolveVaultDataDir(process.env, options.dataDir);
  const vaultPath = join(vaultDir, "vault.db");
  const readOnly = options.overrides.readOnlyStore === true;
  const transient = options.overrides.transientVault === true && !readOnly;
  if (transient && process.env.NODE_ENV === "production") {
    throw new TransientVaultInProductionError();
  }
  if (readOnly && !existsSync(vaultPath)) {
    return new EmptyReadOnlyVault();
  }
  if (!readOnly && !transient) {
    await mkdir(vaultDir, { recursive: true });
  }
  return new SqliteVault(
    transient ? ":memory:" : vaultPath,
    options.keys,
    () => options.clock.now(),
    {
      readonly: readOnly,
    },
  );
}
