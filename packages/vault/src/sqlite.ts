// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { CryptoError, aesGcmEncrypt, hmacSha256 } from "@harness/crypto";
import { Id, VaultValueEntrySchema } from "@harness/schemas";
import type { Code, KeyProvider, VaultValueEntry } from "@harness/schemas";
import { normalize } from "./normalize.js";
import { Token, tokenTypeName, type Token as TokenValue } from "./token.js";
import { VaultOperationError } from "./errors.js";
import { decryptSqliteEntry } from "./sqlite-decrypt.js";
import { migrateVault, validateReadOnlyVaultMigrations } from "./sqlite-migrations.js";
import type { ReencryptBatchResult, VaultKeyRotation, VaultReencryptBatchInput } from "./rotate.js";
import {
  currentKeyId,
  deriveVaultKeys,
  loadMasterKey,
  lookupMessage,
  type VaultKeys,
} from "./sqlite-crypto.js";
import { countVaultRowsByKey, reencryptVaultBatch } from "./sqlite-rotation.js";
import {
  VaultValueError,
  type VaultAdmin,
  type VaultReader,
  type VaultResolver,
  VaultTerminalRunsQuerySchema,
  VaultTimestampSchema,
  type VaultWriter,
  type VaultResolveContext,
} from "./types.js";

const MAX_VALUE_BYTES = 8 * 1024;
const MAX_TOKEN_NUMBER = 999_999;
interface VaultEntryRow {
  token: string;
  entity_type?: string;
  value_enc: string;
  key_id: string;
}

interface PutTransactionInput {
  runId: Id;
  entityType: Code;
  typeName: string;
  rawValue: string;
  lookups: readonly Buffer[];
  keyId: string;
  keys: VaultKeys;
}

interface InsertEntryInput {
  runId: Id;
  entityType: Code;
  token: TokenValue;
  lookup: Buffer;
  encrypted: Uint8Array;
  keyId: string;
}

/** SQLite-backed encrypted vault isolated in its own database file. */
export class SqliteVault
  implements VaultWriter, VaultResolver, VaultReader, VaultAdmin, VaultKeyRotation
{
  private readonly db: Database.Database;

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
    const rawValue = raw.trim();
    if (rawValue.length === 0) {
      throw new VaultValueError("vault_value_empty");
    }
    if (new TextEncoder().encode(rawValue).byteLength > MAX_VALUE_BYTES) {
      throw new VaultValueError("vault_value_too_large");
    }

    const normalizedValue = normalize(entityType, rawValue);
    const typeName = tokenTypeName(entityType);
    const keyId = currentKeyId(this.keyProvider);
    const keys = await deriveVaultKeys(this.keyProvider, keyId, "vault_encrypt_failed");
    const message = lookupMessage(runId, entityType, normalizedValue);
    const lookups: Buffer[] = [];

    try {
      const referencedKeyIds = this.db
        .prepare<[], { lookup_key_id: string }>(
          "SELECT DISTINCT lookup_key_id FROM vault_entries ORDER BY lookup_key_id",
        )
        .all()
        .map(({ lookup_key_id }) => lookup_key_id);
      const keyIds = Array.from(new Set([keyId, ...referencedKeyIds]));
      for (const lookupKeyId of keyIds) {
        if (lookupKeyId === keyId) {
          lookups.push(Buffer.from(hmacSha256(keys.lookup, message)));
          continue;
        }
        const historicalKeys = await deriveVaultKeys(
          this.keyProvider,
          lookupKeyId,
          "vault_encrypt_failed",
        );
        try {
          lookups.push(Buffer.from(hmacSha256(historicalKeys.lookup, message)));
        } finally {
          historicalKeys.encryption.fill(0);
          historicalKeys.lookup.fill(0);
        }
      }
      return this.putTransaction({
        runId,
        entityType,
        typeName,
        rawValue,
        lookups,
        keyId,
        keys,
      });
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
    return Promise.all(this.readValueRows(runId).map((row) => this.decryptEntry(runId, row)));
  }

  /** Return detached values and entity types for metadata-only sentinel alerts. */
  async listRawValueEntries(runId: Id): Promise<readonly VaultValueEntry[]> {
    const rows = this.readValueRows(runId);
    return Promise.all(
      rows.map(async (row) =>
        VaultValueEntrySchema.parse({
          entityType: row.entity_type,
          rawValue: await this.decryptEntry(runId, row),
        }),
      ),
    );
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
    const terminalAt = VaultTimestampSchema.parse(ts);
    try {
      this.db
        .prepare(
          "INSERT INTO run_meta (run_id, terminal_at) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET terminal_at = MIN(terminal_at, excluded.terminal_at)",
        )
        .run(runId, terminalAt);
      return Promise.resolve();
    } catch {
      return Promise.reject(new VaultOperationError("vault_unavailable"));
    }
  }

  /** Find a stable batch of terminal runs older than the supplied timestamp. */
  listTerminalRunsBefore(query: {
    readonly terminalBefore: number;
    readonly limit: number;
  }): Promise<readonly Id[]> {
    const { terminalBefore, limit } = VaultTerminalRunsQuerySchema.parse(query);
    try {
      const rows = this.db
        .prepare<[number, number], { run_id: string }>(
          "SELECT run_id FROM run_meta WHERE terminal_at < ? ORDER BY terminal_at, run_id LIMIT ?",
        )
        .all(terminalBefore, limit);
      return Promise.resolve(rows.map(({ run_id }) => Id.parse(run_id)));
    } catch {
      return Promise.reject(new VaultOperationError("vault_unavailable"));
    }
  }

  /** Return a monotonic version for entries ever added to or purged from a run. */
  version(runId: Id): Promise<number> {
    try {
      const row = this.db
        .prepare<[Id, Id], { version: number }>(
          "SELECT COALESCE(SUM(next_n - 1), 0) + COALESCE((SELECT purge_epoch FROM vault_purge_epochs WHERE run_id = ?), 0) AS version FROM vault_counters WHERE run_id = ?",
        )
        .get(runId, runId);
      return Promise.resolve(row?.version ?? 0);
    } catch {
      return Promise.reject(new VaultOperationError("vault_unavailable"));
    }
  }

  /** Remove a run's encrypted entries, advance its version, and preserve token numbering. */
  purge(runId: Id): Promise<number> {
    try {
      const purge = this.db.transaction(() => {
        const result = this.db
          .prepare<[Id]>("DELETE FROM vault_entries WHERE run_id = ?")
          .run(runId);
        this.db.prepare<[Id]>("DELETE FROM run_meta WHERE run_id = ?").run(runId);
        if (result.changes > 0) {
          this.db
            .prepare<[Id]>(
              "INSERT INTO vault_purge_epochs (run_id, purge_epoch) VALUES (?, 1) ON CONFLICT(run_id) DO UPDATE SET purge_epoch = vault_purge_epochs.purge_epoch + 1",
            )
            .run(runId);
        }
        return result.changes;
      });
      return Promise.resolve(purge.immediate());
    } catch {
      return Promise.reject(new VaultOperationError("vault_unavailable"));
    }
  }

  /** Return the current entry count for a run. */
  stats(runId: Id): Promise<{ entries: number }> {
    try {
      const row = this.db
        .prepare<[Id], { entries: number }>(
          "SELECT COUNT(*) AS entries FROM vault_entries WHERE run_id = ?",
        )
        .get(runId);
      return Promise.resolve({ entries: row?.entries ?? 0 });
    } catch {
      return Promise.reject(new VaultOperationError("vault_unavailable"));
    }
  }

  /** {@inheritDoc VaultKeyRotation.reencryptBatch} */
  reencryptBatch(input: VaultReencryptBatchInput): Promise<ReencryptBatchResult> {
    return reencryptVaultBatch(this.db, this.keyProvider, input, (runId, row) =>
      this.decryptEntry(runId, row),
    );
  }

  /** Count rows that still need each encryption or lookup key. */
  countRowsByKey(): Promise<readonly { keyId: string; count: number }[]> {
    return countVaultRowsByKey(this.db);
  }

  /** Close the dedicated SQLite connection. */
  close(): void {
    this.db.close();
  }

  private putTransaction({
    runId,
    entityType,
    typeName,
    rawValue,
    lookups,
    keyId,
    keys,
  }: PutTransactionInput): TokenValue {
    const put = this.db.transaction(() => {
      const findExisting = this.db.prepare<[Id, Code, Buffer], { token: string }>(
        "SELECT token FROM vault_entries WHERE run_id = ? AND entity_type = ? AND lookup = ?",
      );
      let existing: { token: string } | undefined;
      for (const lookup of lookups) {
        existing = findExisting.get(runId, entityType, lookup);
        if (existing !== undefined) {
          break;
        }
      }
      if (existing !== undefined) {
        const token = Token.safeParse(existing.token);
        if (!token.success) {
          throw new VaultOperationError("vault_unavailable");
        }
        return token.data;
      }

      const counter = this.db
        .prepare<[Id, string], { next_n: number }>(
          "SELECT next_n FROM vault_counters WHERE run_id = ? AND entity_type = ?",
        )
        .get(runId, typeName);
      const nextNumber = counter?.next_n ?? 1;
      if (nextNumber > MAX_TOKEN_NUMBER) {
        throw new VaultValueError("vault_token_space_exhausted");
      }
      const token = Token.safeParse(`<${typeName}_${String(nextNumber)}>`);
      if (!token.success) {
        throw new VaultValueError("vault_entity_type_invalid");
      }

      const plaintext = Buffer.from(rawValue, "utf8");
      let encrypted: Uint8Array | undefined;
      try {
        encrypted = aesGcmEncrypt(
          keys.encryption,
          plaintext,
          Buffer.from(`${runId}:${token.data}`, "utf8"),
        );
        this.insertEntry({
          runId,
          entityType,
          token: token.data,
          lookup: lookups[0] ?? Buffer.alloc(0),
          encrypted,
          keyId,
        });
        this.incrementCounter(runId, typeName, nextNumber + 1);
        return token.data;
      } finally {
        plaintext.fill(0);
        encrypted?.fill(0);
      }
    });
    return put.immediate();
  }

  private insertEntry({
    runId,
    entityType,
    token,
    lookup,
    encrypted,
    keyId,
  }: InsertEntryInput): void {
    this.db
      .prepare(
        "INSERT INTO vault_entries (run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        token,
        entityType,
        lookup,
        Buffer.from(encrypted).toString("base64"),
        keyId,
        keyId,
        this.now(),
      );
  }

  private incrementCounter(runId: Id, typeName: string, nextNumber: number): void {
    this.db
      .prepare(
        "INSERT INTO vault_counters (run_id, entity_type, next_n) VALUES (?, ?, ?) ON CONFLICT(run_id, entity_type) DO UPDATE SET next_n = excluded.next_n",
      )
      .run(runId, typeName, nextNumber);
  }

  private async decryptEntry(runId: Id, row: VaultEntryRow): Promise<string> {
    return decryptSqliteEntry(runId, row, this.keyProvider, loadMasterKey);
  }
}
