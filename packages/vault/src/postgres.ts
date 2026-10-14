// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hmacSha256 } from "@harness/crypto";
import {
  Id,
  VaultValueEntrySchema,
  type Code,
  type KeyProvider,
  type VaultValueEntry,
} from "@harness/schemas";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { z } from "zod";
import { VaultOperationError } from "./errors.js";
import { normalize } from "./normalize.js";
import { Token, tokenTypeName, type Token as TokenValue } from "./token.js";
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
import {
  createWrappedScopeKey,
  decryptScopeValue,
  encryptScopeValue,
  unwrapScopeKey,
} from "./scope-crypto.js";
import { currentKeyId, deriveVaultKeys, lookupMessage } from "./sqlite-crypto.js";

const MAX_VALUE_BYTES = 8 * 1024;
const MAX_TOKEN_NUMBER = 999_999;
const POSTGRES_MIGRATION = fileURLToPath(
  new URL("../migrations/postgres/0001_init.sql", import.meta.url),
);
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

interface ScopeKeyRow extends QueryResultRow {
  wrapped_dek: Buffer;
  key_id: string;
}

interface ScopeDataKey {
  readonly dataKey: Uint8Array;
  readonly keyId: string;
  readonly wrappedDek: Buffer;
}

interface PutInput {
  readonly runId: Id;
  readonly entityType: Code;
  readonly rawValue: string;
  readonly typeName: string;
  readonly keyId: string;
  readonly lookupKey: Uint8Array;
}

interface DatabaseIdentity extends QueryResultRow {
  system_identifier: string;
  database_name: string;
  schema_name: string;
  role_name: string;
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

function entryToken(value: string): TokenValue {
  const parsed = Token.safeParse(value);
  if (!parsed.success) {
    throw new VaultOperationError("vault_unavailable");
  }
  return parsed.data;
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
    const client = await this.pool.connect().catch(() => {
      throw new VaultOperationError("vault_unavailable");
    });
    let transactionStarted = false;
    try {
      await this.assertSeparateDatabase(client);
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema())::bigint)");
      await client.query(
        "CREATE TABLE IF NOT EXISTS vault_schema_migrations (version text PRIMARY KEY)",
      );
      const applied = await client.query<{ version: string } & QueryResultRow>(
        "SELECT version FROM vault_schema_migrations",
      );
      if (applied.rows.some(({ version }) => version !== "0001_init")) {
        throw new VaultOperationError("vault_migration_newer_than_code");
      }
      if (applied.rows.length === 0) {
        const migration = readFileSync(POSTGRES_MIGRATION, "utf8");
        await client.query(migration);
        await client.query("INSERT INTO vault_schema_migrations (version) VALUES ($1)", [
          "0001_init",
        ]);
      }
      await client.query("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      mapVaultError(error);
    } finally {
      client.release();
    }
  }

  private async assertSeparateDatabase(client: PoolClient): Promise<void> {
    if (this.storePool === undefined) {
      return;
    }
    const identityQuery =
      "SELECT (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier, current_database() AS database_name, current_schema() AS schema_name, current_user AS role_name";
    const [vaultIdentityResult, storeIdentityResult] = await Promise.all([
      client.query<DatabaseIdentity>(identityQuery),
      this.storePool.query<DatabaseIdentity>(identityQuery),
    ]);
    const vaultIdentity = vaultIdentityResult.rows[0];
    const storeIdentity = storeIdentityResult.rows[0];
    if (vaultIdentity === undefined || storeIdentity === undefined) {
      throw new VaultOperationError("vault_unavailable");
    }
    if (
      vaultIdentity.system_identifier === storeIdentity.system_identifier &&
      vaultIdentity.database_name === storeIdentity.database_name &&
      (vaultIdentity.schema_name === storeIdentity.schema_name ||
        vaultIdentity.role_name === storeIdentity.role_name)
    ) {
      throw new VaultOperationError("vault_shares_store_database");
    }
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

  private async scopeKey(client: PoolClient, scopeId: Id, keyId: string): Promise<ScopeDataKey> {
    const existing = await client.query<ScopeKeyRow>(
      "SELECT wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = $1 FOR UPDATE",
      [scopeId],
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      const dataKey = await unwrapScopeKey(this.keyProvider, row.key_id, scopeId, row.wrapped_dek);
      return { dataKey, keyId: row.key_id, wrappedDek: Buffer.from(row.wrapped_dek) };
    }

    const candidate = await createWrappedScopeKey(this.keyProvider, keyId, scopeId);
    let installed = false;
    try {
      const inserted = await client.query(
        "INSERT INTO vault_scope_keys (scope_id, wrapped_dek, key_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (scope_id) DO NOTHING RETURNING scope_id",
        [scopeId, candidate.wrappedDek, keyId, this.now()],
      );
      if (inserted.rows.length > 0) {
        installed = true;
        return {
          dataKey: candidate.dataKey,
          keyId,
          wrappedDek: Buffer.from(candidate.wrappedDek),
        };
      }
    } finally {
      candidate.wrappedDek.fill(0);
      if (!installed) {
        candidate.dataKey.fill(0);
      }
    }
    const raced = await client.query<ScopeKeyRow>(
      "SELECT wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = $1 FOR UPDATE",
      [scopeId],
    );
    const racedRow = raced.rows[0];
    if (racedRow === undefined) {
      throw new VaultOperationError("vault_unavailable");
    }
    return {
      dataKey: await unwrapScopeKey(
        this.keyProvider,
        racedRow.key_id,
        scopeId,
        racedRow.wrapped_dek,
      ),
      keyId: racedRow.key_id,
      wrappedDek: Buffer.from(racedRow.wrapped_dek),
    };
  }

  private async lookupKeys(
    client: PoolClient,
    scope: {
      readonly id: Id;
      readonly entityType: Code;
      readonly normalizedValue: string;
      readonly keyId: string;
      readonly lookupKey: Uint8Array;
    },
  ): Promise<Buffer[]> {
    const result = await client.query<{ lookup_key_id: string } & QueryResultRow>(
      "SELECT DISTINCT lookup_key_id FROM vault_entries WHERE run_id = $1 ORDER BY lookup_key_id",
      [scope.id],
    );
    const message = lookupMessage(scope.id, scope.entityType, scope.normalizedValue);
    const lookupKeys: Buffer[] = [];
    try {
      const keyIds = Array.from(
        new Set([scope.keyId, ...result.rows.map(({ lookup_key_id }) => lookup_key_id)]),
      );
      for (const lookupKeyId of keyIds) {
        if (lookupKeyId === scope.keyId) {
          lookupKeys.push(Buffer.from(hmacSha256(scope.lookupKey, message)));
          continue;
        }
        const oldKeys = await deriveVaultKeys(
          this.keyProvider,
          lookupKeyId,
          "vault_encrypt_failed",
        );
        try {
          lookupKeys.push(Buffer.from(hmacSha256(oldKeys.lookup, message)));
        } finally {
          oldKeys.encryption.fill(0);
          oldKeys.lookup.fill(0);
        }
      }
      return lookupKeys;
    } catch (error) {
      lookupKeys.forEach((lookup) => lookup.fill(0));
      mapVaultError(error);
    } finally {
      message.fill(0);
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
        this.putInTransaction(client, {
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

  private async putInTransaction(client: PoolClient, input: PutInput): Promise<TokenValue> {
    const { runId, entityType, rawValue, typeName, keyId, lookupKey } = input;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runId]);
    const scopeKey = await this.scopeKey(client, runId, keyId);
    let lookups: Buffer[] = [];
    try {
      lookups = await this.lookupKeys(client, {
        id: runId,
        entityType,
        normalizedValue: normalize(entityType, rawValue),
        keyId,
        lookupKey,
      });
      for (const lookup of lookups) {
        const existing = await client.query<{ token: string } & QueryResultRow>(
          "SELECT token FROM vault_entries WHERE run_id = $1 AND entity_type = $2 AND lookup = $3",
          [runId, entityType, lookup],
        );
        const token = existing.rows[0]?.token;
        if (token !== undefined) {
          return entryToken(token);
        }
      }
      await client.query(
        "INSERT INTO vault_counters (run_id, entity_type, next_n) VALUES ($1, $2, 1) ON CONFLICT (run_id, entity_type) DO NOTHING",
        [runId, typeName],
      );
      const allocated = await client.query<{ next_n: number | string } & QueryResultRow>(
        "UPDATE vault_counters SET next_n = next_n + 1 WHERE run_id = $1 AND entity_type = $2 RETURNING next_n - 1 AS next_n",
        [runId, typeName],
      );
      const number = safeInteger(allocated.rows[0]?.next_n);
      if (number < 1 || number > MAX_TOKEN_NUMBER) {
        throw new VaultValueError("vault_token_space_exhausted");
      }
      const token = Token.safeParse(`<${typeName}_${String(number)}>`);
      if (!token.success) {
        throw new VaultValueError("vault_entity_type_invalid");
      }
      const lookup = lookups[0];
      if (lookup === undefined) {
        throw new VaultOperationError("vault_encrypt_failed");
      }
      const valueEnc = encryptScopeValue(scopeKey.dataKey, rawValue, `${runId}:${token.data}`);
      const inserted = await client.query<{ token: string } & QueryResultRow>(
        `INSERT INTO vault_entries
          (run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (run_id, entity_type, lookup) DO NOTHING RETURNING token`,
        [runId, token.data, entityType, lookup, valueEnc, scopeKey.keyId, keyId, this.now()],
      );
      const insertedToken = inserted.rows[0]?.token;
      if (insertedToken !== undefined) {
        return entryToken(insertedToken);
      }
      for (const candidate of lookups) {
        const duplicate = await client.query<{ token: string } & QueryResultRow>(
          "SELECT token FROM vault_entries WHERE run_id = $1 AND entity_type = $2 AND lookup = $3",
          [runId, entityType, candidate],
        );
        const duplicateToken = duplicate.rows[0]?.token;
        if (duplicateToken !== undefined) {
          return entryToken(duplicateToken);
        }
      }
      throw new VaultOperationError("vault_unavailable");
    } finally {
      scopeKey.dataKey.fill(0);
      scopeKey.wrappedDek.fill(0);
      lookups.forEach((lookup) => lookup.fill(0));
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
      return row === undefined ? undefined : await this.decryptEntry(runId, row);
    } catch (error) {
      mapVaultError(error);
    }
  }

  private async decryptEntry(runId: Id, row: EntryRow): Promise<string> {
    const scopeKey = await this.pool.query<ScopeKeyRow>(
      "SELECT wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = $1",
      [runId],
    );
    const wrapped = scopeKey.rows[0];
    if (wrapped === undefined) {
      throw new VaultOperationError("vault_decrypt_failed");
    }
    const dataKey = await unwrapScopeKey(
      this.keyProvider,
      wrapped.key_id,
      runId,
      wrapped.wrapped_dek,
    );
    try {
      return decryptScopeValue(dataKey, row.value_enc, `${runId}:${row.token}`);
    } finally {
      dataKey.fill(0);
    }
  }

  private async decryptRows(runId: Id, rows: readonly EntryRow[]): Promise<Uint8Array | undefined> {
    if (rows.length === 0) {
      return undefined;
    }
    const scopeKey = await this.pool.query<ScopeKeyRow>(
      "SELECT wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = $1",
      [runId],
    );
    const wrapped = scopeKey.rows[0];
    if (wrapped === undefined) {
      throw new VaultOperationError("vault_decrypt_failed");
    }
    return unwrapScopeKey(this.keyProvider, wrapped.key_id, runId, wrapped.wrapped_dek);
  }

  /** Return detached values for leak detection. */
  async listRawValues(runId: Id): Promise<readonly string[]> {
    try {
      const rows = await this.readRows(runId);
      const dataKey = await this.decryptRows(runId, rows);
      if (dataKey === undefined) {
        return [];
      }
      try {
        return rows.map((row) =>
          decryptScopeValue(dataKey, row.value_enc, `${runId}:${row.token}`),
        );
      } finally {
        dataKey.fill(0);
      }
    } catch (error) {
      mapVaultError(error);
    }
  }

  /** Return detached values with entity types. */
  async listRawValueEntries(runId: Id): Promise<readonly VaultValueEntry[]> {
    try {
      const rows = await this.readRows(runId);
      const dataKey = await this.decryptRows(runId, rows);
      if (dataKey === undefined) {
        return [];
      }
      try {
        return rows.map((row) =>
          VaultValueEntrySchema.parse({
            entityType: row.entity_type,
            rawValue: decryptScopeValue(dataKey, row.value_enc, `${runId}:${row.token}`),
          }),
        );
      } finally {
        dataKey.fill(0);
      }
    } catch (error) {
      mapVaultError(error);
    }
  }

  private async readRows(runId: Id): Promise<EntryRow[]> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<EntryRow>(
        "SELECT run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id FROM vault_entries WHERE run_id = $1 ORDER BY token",
        [runId],
      );
      return result.rows;
    } catch (error) {
      mapVaultError(error);
    }
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
