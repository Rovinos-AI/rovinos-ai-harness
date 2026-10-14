// SPDX-License-Identifier: Apache-2.0
import { Id, type Code, type KeyProvider, type VaultValueEntry } from "@harness/schemas";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { z } from "zod";
import { VaultOperationError } from "./errors.js";
import { tokenTypeName, type Token as TokenValue } from "./token.js";
import {
  VaultValueError,
  VaultTerminalRunsQuerySchema,
  VaultTimestampSchema,
  type VaultAdmin,
  type VaultReader,
  type VaultResolver,
  type VaultResolveContext,
  type VaultWriter,
} from "./types.js";
import {
  VaultKeyRowCountSchema,
  type ReencryptBatchResult,
  type VaultKeyRotation,
  type VaultReencryptBatchInput,
} from "./rotate.js";
import { reencryptPostgresBatch } from "./postgres-rotation.js";
import { initializePostgresVault } from "./postgres-initialize.js";
import { putPostgresEntry } from "./postgres-write.js";
import {
  listPostgresValueEntries,
  listPostgresValues,
  readPostgresValue,
} from "./postgres-reader.js";
import { currentKeyId, deriveVaultKeys } from "./sqlite-crypto.js";

const MAX_VALUE_BYTES = 8 * 1024;
const postgresUrlSchema = z
  .url()
  .refine(
    (value) =>
      URL.canParse(value) && ["postgres:", "postgresql:"].includes(new URL(value).protocol),
  );
const schemaNameSchema = z.string().regex(/^[a-z_]\w{0,62}$/i);
const optionsSchema = z
  .object({
    storeConnectionString: postgresUrlSchema.optional(),
    schema: schemaNameSchema.default("public"),
    storeSchema: schemaNameSchema.default("public"),
    poolSize: z.number().int().min(1).max(100).default(10),
  })
  .strict();

/** Options for a Postgres vault, including the event-store location for separation checks. */
export interface PostgresVaultOptions {
  readonly storeConnectionString?: string;
  readonly schema?: string;
  readonly storeSchema?: string;
  readonly poolSize?: number;
  readonly now?: () => number;
}

interface EntryRow extends QueryResultRow {
  run_id: string;
  token: string;
  entity_type: string;
  lookup: Buffer | null;
  value_enc: string;
  key_id: string;
  lookup_key_id: string;
}

function databaseIdentity(connectionString: string): string {
  const url = new URL(connectionString);
  const port = url.port.length === 0 ? "5432" : url.port;
  const database = url.pathname.replace(/^\/+/, "");
  return `${url.hostname.toLowerCase()}:${port}/${database}`;
}

function databaseRole(connectionString: string): string {
  return new URL(connectionString).username;
}

function safeInteger(value: number | string | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new VaultOperationError("vault_unavailable");
  }
  return parsed;
}

function validateRawValue(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) {
    throw new VaultValueError("vault_value_empty");
  }
  if (new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) {
    throw new VaultValueError("vault_value_too_large");
  }
  return value;
}

function mapVaultError(error: unknown): never {
  if (error instanceof VaultOperationError || error instanceof VaultValueError) {
    throw error;
  }
  throw new VaultOperationError("vault_unavailable");
}

/** Shared Postgres vault; its connection must be distinct from the event-store schema. */
export class PostgresVault
  implements VaultWriter, VaultResolver, VaultReader, VaultAdmin, VaultKeyRotation
{
  private readonly pool: Pool;
  private readonly storePool: Pool | undefined;
  private readonly schema: string;
  private readonly now: () => number;
  private initialized: Promise<void> | undefined;

  /**
   * Open a Postgres vault connection and reject a shared event-store database/schema.
   * The connection URLs must already be resolved from their configured SecretRefs.
   */
  constructor(
    connectionString: string,
    private readonly keyProvider: KeyProvider,
    options: PostgresVaultOptions,
  ) {
    const { now = Date.now, ...connectionOptions } = options;
    const parsedUrl = postgresUrlSchema.safeParse(connectionString);
    const parsedOptions = optionsSchema.safeParse(connectionOptions);
    if (!parsedUrl.success || !parsedOptions.success) {
      throw new VaultOperationError("vault_unavailable");
    }
    const storeUrl = parsedOptions.data.storeConnectionString;
    if (storeUrl !== undefined) {
      const sameDatabase = databaseIdentity(parsedUrl.data) === databaseIdentity(storeUrl);
      const sameSchema = parsedOptions.data.schema === parsedOptions.data.storeSchema;
      const sameRole = databaseRole(parsedUrl.data) === databaseRole(storeUrl);
      if (sameDatabase && (sameSchema || sameRole)) {
        throw new VaultOperationError("vault_shares_store_database");
      }
    }
    this.schema = parsedOptions.data.schema;
    this.now = now;
    this.pool = new Pool({
      connectionString: parsedUrl.data,
      max: parsedOptions.data.poolSize,
      options: `-c search_path="${this.schema}"`,
    });
    this.storePool =
      storeUrl === undefined ? undefined : new Pool({ connectionString: storeUrl, max: 1 });
    this.pool.on("error", () => undefined);
    this.storePool?.on("error", () => undefined);
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.initializePool().catch((error: unknown) => {
      this.initialized = undefined;
      mapVaultError(error);
    });
    return this.initialized;
  }

  /** Verify database separation and apply migrations before the adapter is used. */
  initialize(): Promise<void> {
    return this.ensureInitialized();
  }

  private async initializePool(): Promise<void> {
    await initializePostgresVault(this.pool, this.storePool).catch((error: unknown) => {
      mapVaultError(error);
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    const client = await this.pool.connect().catch(() => {
      throw new VaultOperationError("vault_unavailable");
    });
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      mapVaultError(error);
    } finally {
      client.release();
    }
  }

  /** Store a trimmed value or reuse its idempotent scope token. */
  async put(runId: Id, entityType: Code, raw: string): Promise<TokenValue> {
    const rawValue = validateRawValue(raw);
    const typeName = tokenTypeName(entityType);
    const keyId = currentKeyId(this.keyProvider);
    const keys = await deriveVaultKeys(this.keyProvider, keyId, "vault_encrypt_failed");
    try {
      return await this.transaction((client) =>
        putPostgresEntry({ keyProvider: this.keyProvider, now: this.now }, client, {
          runId,
          entityType,
          rawValue,
          typeName,
          keyId,
          lookupKey: keys.lookup,
        }),
      );
    } catch (error) {
      mapVaultError(error);
    } finally {
      keys.encryption.fill(0);
      keys.lookup.fill(0);
    }
  }

  /** Resolve one token only within its owning scope. */
  async resolve(
    runId: Id,
    token: TokenValue,
    _context: VaultResolveContext,
  ): Promise<string | undefined> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<EntryRow>(
        "SELECT run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id FROM vault_entries WHERE run_id = $1 AND token = $2",
        [runId, token],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : await readPostgresValue(this.readerContext(), runId, row.token, row.value_enc);
    } catch (error) {
      mapVaultError(error);
    }
  }

  /** Return detached values for leak detection. */
  listRawValues(runId: Id): Promise<readonly string[]> {
    return listPostgresValues(this.readerContext(), runId);
  }

  /** Return detached values with entity types. */
  listRawValueEntries(runId: Id): Promise<readonly VaultValueEntry[]> {
    return listPostgresValueEntries(this.readerContext(), runId);
  }

  private readerContext() {
    return {
      pool: this.pool,
      keyProvider: this.keyProvider,
      ensureInitialized: () => this.ensureInitialized(),
    };
  }

  /** Return the sum of allocated token counters and completed purge epochs. */
  async version(runId: Id): Promise<number> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<{ version: number | string } & QueryResultRow>(
        `SELECT COALESCE((SELECT SUM(next_n - 1) FROM vault_counters WHERE run_id = $1), 0) +
          COALESCE((SELECT purge_epoch FROM vault_purge_epochs WHERE run_id = $1), 0) AS version`,
        [runId],
      );
      return safeInteger(result.rows[0]?.version);
    } catch (error) {
      mapVaultError(error);
    }
  }

  /** Mark the run terminal, retaining the earliest terminal timestamp. */
  async markTerminal(runId: Id, ts: number): Promise<void> {
    const terminalAt = VaultTimestampSchema.parse(ts);
    try {
      await this.ensureInitialized();
      await this.pool.query(
        "INSERT INTO run_meta (run_id, terminal_at) VALUES ($1, $2) ON CONFLICT (run_id) DO UPDATE SET terminal_at = LEAST(run_meta.terminal_at, EXCLUDED.terminal_at)",
        [runId, terminalAt],
      );
    } catch (error) {
      mapVaultError(error);
    }
  }

  /** Return terminal runs older than the given timestamp in stable order. */
  async listTerminalRunsBefore(query: {
    readonly terminalBefore: number;
    readonly limit: number;
  }): Promise<readonly Id[]> {
    const { terminalBefore, limit } = VaultTerminalRunsQuerySchema.parse(query);
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<{ run_id: string } & QueryResultRow>(
        "SELECT run_id FROM run_meta WHERE terminal_at < $1 ORDER BY terminal_at, run_id LIMIT $2",
        [terminalBefore, limit],
      );
      return result.rows.map(({ run_id }) => Id.parse(run_id));
    } catch (error) {
      mapVaultError(error);
    }
  }

  /** Delete the wrapped scope key before deleting its encrypted entries. */
  async purge(runId: Id): Promise<number> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runId]);
      await client.query("DELETE FROM vault_scope_keys WHERE scope_id = $1", [runId]);
      const result = await client.query("DELETE FROM vault_entries WHERE run_id = $1", [runId]);
      await client.query("DELETE FROM run_meta WHERE run_id = $1", [runId]);
      if ((result.rowCount ?? 0) > 0) {
        await client.query(
          "INSERT INTO vault_purge_epochs (run_id, purge_epoch) VALUES ($1, 1) ON CONFLICT (run_id) DO UPDATE SET purge_epoch = vault_purge_epochs.purge_epoch + 1",
          [runId],
        );
      }
      return result.rowCount ?? 0;
    });
  }

  /** Count entries for one scope. */
  async stats(runId: Id): Promise<{ entries: number }> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<{ entries: number | string } & QueryResultRow>(
        "SELECT COUNT(*) AS entries FROM vault_entries WHERE run_id = $1",
        [runId],
      );
      return { entries: safeInteger(result.rows[0]?.entries) };
    } catch (error) {
      mapVaultError(error);
    }
  }

  /** Re-wrap each selected scope DEK and rotate its lookup HMACs atomically. */
  async reencryptBatch(input: VaultReencryptBatchInput): Promise<ReencryptBatchResult> {
    return reencryptPostgresBatch(
      {
        keyProvider: this.keyProvider,
        transaction: (work) => this.transaction(work),
      },
      input,
    );
  }

  /** Count entries still referencing an encryption or lookup key. */
  async countRowsByKey(): Promise<readonly { keyId: string; count: number }[]> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<
        { key_id: string; count: number | string } & QueryResultRow
      >(
        `SELECT key_id, COUNT(*) AS count FROM (
            SELECT key_id, run_id, token FROM vault_entries
            UNION
            SELECT lookup_key_id AS key_id, run_id, token FROM vault_entries
          ) AS keys_in_use GROUP BY key_id ORDER BY key_id`,
      );
      return result.rows.map(({ key_id, count }) =>
        VaultKeyRowCountSchema.parse({ keyId: key_id, count: safeInteger(count) }),
      );
    } catch (error) {
      mapVaultError(error);
    }
  }

  /** Close the shared Postgres pool. */
  async close(): Promise<void> {
    try {
      await Promise.all([this.pool.end(), this.storePool?.end()]);
    } catch (error) {
      mapVaultError(error);
    }
  }
}
