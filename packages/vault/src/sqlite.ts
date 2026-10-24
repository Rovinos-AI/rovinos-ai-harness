// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { CryptoError } from "@rovinos/crypto";
import { VaultValueEntrySchema } from "@rovinos/schemas";
import type { Code, Id, KeyProvider, VaultValueEntry } from "@rovinos/schemas";
import { normalize } from "./normalize.js";
import { tokenTypeName, type Token as TokenValue } from "./token.js";
import { VaultOperationError } from "./errors.js";
import { decryptSqliteEntry } from "./sqlite-decrypt.js";
import { decryptScopeValue, unwrapScopeKey } from "./scope-crypto.js";
import { migrateVault, validateReadOnlyVaultMigrations } from "./sqlite-migrations.js";
import type { ReencryptBatchResult, VaultKeyRotation, VaultReencryptBatchInput } from "./rotate.js";
import { currentKeyId, deriveVaultKeys, loadMasterKey, lookupMessage } from "./sqlite-crypto.js";
import { appendLookupCandidates } from "./sqlite-lookup.js";
import { putSqliteTransaction, RetryScopeKeyError } from "./sqlite-write.js";
import {
  listSqliteTerminalRuns,
  markSqliteTerminal,
  purgeSqliteScope,
  sqliteVaultStats,
  sqliteVaultVersion,
} from "./sqlite-admin.js";
import { countVaultRowsByKey, reencryptVaultBatch } from "./sqlite-rotation.js";
import { convertSqliteLegacyScopes, ensureSqliteScopeDataKey } from "./sqlite-scope-key.js";
import {
  VaultValueError,
  type VaultAdmin,
  type VaultReader,
  type VaultResolver,
  type VaultWriter,
  type VaultResolveContext,
} from "./types.js";

const MAX_VALUE_BYTES = 8 * 1024;
interface VaultEntryRow {
  token: string;
  entity_type?: string;
  value_enc: string;
  key_id: string;
}

interface ScopeKeyRow {
  scope_id: string;
  wrapped_dek: Buffer;
  key_id: string;
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

/** SQLite-backed encrypted vault isolated in its own database file. */
export class SqliteVault
  implements VaultWriter, VaultResolver, VaultReader, VaultAdmin, VaultKeyRotation
{
  private readonly db: Database.Database;
  private readonly readOnly: boolean;
  private legacyConversion: Promise<void> | undefined;

  /**
   * Open the vault database, apply its checksummed migrations, and enable secure deletion.
   * @param path SQLite database file path or `:memory:`.
   * @param keyProvider Provider for current and historical vault master keys.
   * @param now Clock used for the entry creation timestamp.
   */
  constructor(
    path: string,
    private readonly keyProvider: KeyProvider,
    private readonly now: () => number = Date.now,
    options: { readonly readonly?: boolean } = {},
  ) {
    const readOnly = options.readonly === true;
    this.readOnly = readOnly;
    try {
      this.db = new Database(path, {
        ...(readOnly ? { readonly: true, fileMustExist: true } : {}),
      });
    } catch {
      throw new VaultOperationError("vault_unavailable");
    }
    try {
      if (readOnly) {
        validateReadOnlyVaultMigrations(this.db);
      } else {
        this.db.pragma("secure_delete = ON");
        this.db.pragma("busy_timeout = 5000");
        migrateVault(this.db);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Store a trimmed value or reuse its existing run-scoped token. `lookup_key_id`
   * records the HMAC key independently so idempotency works across key rotation.
   */
  async put(runId: Id, entityType: Code, raw: string): Promise<TokenValue> {
    const rawValue = validateRawValue(raw);

    const normalizedValue = normalize(entityType, rawValue);
    const typeName = tokenTypeName(entityType);
    const keyId = currentKeyId(this.keyProvider);
    await this.ensureLegacyConverted();
    const keys = await deriveVaultKeys(this.keyProvider, keyId, "vault_encrypt_failed");
    const message = lookupMessage(runId, entityType, normalizedValue);
    const lookups: Buffer[] = [];
    let scopeDataKey: Uint8Array | undefined;

    try {
      await appendLookupCandidates(this.db, this.keyProvider, {
        keyId,
        lookupKey: keys.lookup,
        message,
        lookups,
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const scopeKey = await ensureSqliteScopeDataKey({
          db: this.db,
          keyProvider: this.keyProvider,
          now: this.now,
          scopeId: runId,
          masterKeyId: keyId,
        });
        scopeDataKey = scopeKey.dataKey;
        try {
          return putSqliteTransaction(this.db, this.now, {
            runId,
            entityType,
            typeName,
            rawValue,
            lookups,
            keyId,
            scopeDataKey,
            scopeKeyId: scopeKey.keyId,
            wrappedScopeKey: scopeKey.wrappedDek,
          });
        } catch (error) {
          if (!(error instanceof RetryScopeKeyError)) {
            throw error;
          }
        } finally {
          scopeKey.dataKey.fill(0);
          scopeKey.wrappedDek.fill(0);
          scopeDataKey = undefined;
        }
      }
      throw new VaultOperationError("vault_unavailable");
    } catch (error) {
      if (error instanceof VaultValueError || error instanceof VaultOperationError) {
        throw error;
      }
      if (error instanceof CryptoError) {
        throw new VaultOperationError("vault_encrypt_failed");
      }
      throw new VaultOperationError("vault_unavailable");
    } finally {
      keys.encryption.fill(0);
      keys.lookup.fill(0);
      scopeDataKey?.fill(0);
      message.fill(0);
      for (const lookup of lookups) {
        lookup.fill(0);
      }
    }
  }

  /** Resolve a token only within its owning run. */
  async resolve(
    runId: Id,
    token: TokenValue,
    _context: VaultResolveContext,
  ): Promise<string | undefined> {
    await this.ensureLegacyConverted();
    let row: VaultEntryRow | undefined;
    try {
      row = this.db
        .prepare<[Id, TokenValue], VaultEntryRow>(
          "SELECT token, value_enc, key_id FROM vault_entries WHERE run_id = ? AND token = ?",
        )
        .get(runId, token);
    } catch {
      throw new VaultOperationError("vault_unavailable");
    }
    return row === undefined ? undefined : this.decryptEntry(runId, row);
  }

  /** Return a detached list of decrypted values for leak detection. */
  async listRawValues(runId: Id): Promise<readonly string[]> {
    await this.ensureLegacyConverted();
    return Promise.all(this.readValueRows(runId).map((row) => this.decryptEntry(runId, row)));
  }

  /** Return detached values and entity types for metadata-only sentinel alerts. */
  async listRawValueEntries(runId: Id): Promise<readonly VaultValueEntry[]> {
    await this.ensureLegacyConverted();
    const rows = this.readValueRows(runId);
    const wrapped =
      rows.length === 0
        ? undefined
        : this.db
            .prepare<[Id], ScopeKeyRow>(
              "SELECT scope_id, wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = ?",
            )
            .get(runId);
    const dataKey =
      wrapped === undefined
        ? undefined
        : await unwrapScopeKey(this.keyProvider, wrapped.key_id, runId, wrapped.wrapped_dek);
    try {
      return await Promise.all(
        rows.map(async (row) =>
          VaultValueEntrySchema.parse({
            entityType: row.entity_type,
            rawValue:
              dataKey === undefined
                ? await this.decryptEntry(runId, row)
                : decryptScopeValue(dataKey, row.value_enc, `${runId}:${row.token}`),
          }),
        ),
      );
    } finally {
      dataKey?.fill(0);
    }
  }

  private readValueRows(runId: Id): VaultEntryRow[] {
    try {
      return this.db
        .prepare<[Id], VaultEntryRow>(
          "SELECT token, entity_type, value_enc, key_id FROM vault_entries WHERE run_id = ? ORDER BY token",
        )
        .all(runId);
    } catch {
      throw new VaultOperationError("vault_unavailable");
    }
  }

  /** Record when a run entered a terminal state for grace-period retention. */
  markTerminal(runId: Id, ts: number): Promise<void> {
    return markSqliteTerminal(this.db, runId, ts);
  }

  /** Find a stable batch of terminal runs older than the supplied timestamp. */
  listTerminalRunsBefore(query: {
    readonly terminalBefore: number;
    readonly limit: number;
  }): Promise<readonly Id[]> {
    return listSqliteTerminalRuns(this.db, query);
  }

  /** Return a monotonic version for entries ever added to or purged from a run. */
  version(runId: Id): Promise<number> {
    return sqliteVaultVersion(this.db, runId);
  }

  /** Remove a run's encrypted entries, advance its version, and preserve token numbering. */
  purge(runId: Id): Promise<number> {
    return purgeSqliteScope(this.db, runId);
  }

  /** Return the current entry count for a run. */
  stats(runId: Id): Promise<{ entries: number }> {
    return sqliteVaultStats(this.db, runId);
  }

  /** {@inheritDoc VaultKeyRotation.reencryptBatch} */
  reencryptBatch(input: VaultReencryptBatchInput): Promise<ReencryptBatchResult> {
    return this.ensureLegacyConverted().then(() =>
      reencryptVaultBatch(this.db, this.keyProvider, input, (runId, row) =>
        this.decryptEntry(runId, row),
      ),
    );
  }

  /** Count rows that still need each encryption or lookup key. */
  countRowsByKey(): Promise<readonly { keyId: string; count: number }[]> {
    return this.ensureLegacyConverted().then(() => countVaultRowsByKey(this.db));
  }

  /** Close the dedicated SQLite connection. */
  close(): void {
    this.db.close();
  }

  private async decryptEntry(runId: Id, row: VaultEntryRow): Promise<string> {
    const scopeKey = this.db
      .prepare<[Id], ScopeKeyRow>(
        "SELECT scope_id, wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = ?",
      )
      .get(runId);
    if (scopeKey === undefined) {
      return decryptSqliteEntry(runId, row, this.keyProvider, loadMasterKey);
    }
    const dataKey = await unwrapScopeKey(
      this.keyProvider,
      scopeKey.key_id,
      runId,
      scopeKey.wrapped_dek,
    );
    try {
      return decryptScopeValue(dataKey, row.value_enc, `${runId}:${row.token}`);
    } finally {
      dataKey.fill(0);
    }
  }

  private ensureLegacyConverted(): Promise<void> {
    if (this.readOnly) {
      return Promise.resolve();
    }
    this.legacyConversion ??= convertSqliteLegacyScopes(this.db, this.keyProvider, this.now).catch(
      (error: unknown) => {
        this.legacyConversion = undefined;
        if (error instanceof VaultOperationError) {
          throw error;
        }
        throw new VaultOperationError("vault_unavailable");
      },
    );
    return this.legacyConversion;
  }
}
