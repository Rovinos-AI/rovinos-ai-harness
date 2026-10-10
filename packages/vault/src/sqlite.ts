// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { CryptoError, aesGcmDecrypt, aesGcmEncrypt, hkdfSha256, hmacSha256 } from "@harness/crypto";
import { KEY_PROVIDER_KEY_BYTES, type Code, type Id, type KeyProvider } from "@harness/schemas";
import { normalize } from "./normalize.js";
import { Token, tokenTypeName, type Token as TokenValue } from "./token.js";
import { VaultOperationError } from "./errors.js";
import {
  VaultValueError,
  type VaultAdmin,
  type VaultReader,
  type VaultResolver,
  type VaultWriter,
} from "./types.js";

const MAX_VALUE_BYTES = 8 * 1024;
const MAX_TOKEN_NUMBER = 999_999;
const ENCRYPTION_INFO = "harness/vault/enc";
const LOOKUP_INFO = "harness/vault/lookup";
const MIGRATIONS = [
  {
    version: "0001_init",
    path: fileURLToPath(new URL("../migrations/sqlite/0001_init.sql", import.meta.url)),
  },
] as const;

interface MigrationRow {
  version: string;
  checksum: string;
}

interface VaultEntryRow {
  token: string;
  value_enc: string;
  key_id: string;
}

interface VaultKeys {
  encryption: Uint8Array;
  lookup: Uint8Array;
}

interface PutTransactionInput {
  runId: Id;
  entityType: Code;
  typeName: string;
  rawValue: string;
  lookup: Buffer;
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

function readMigration(path: string): { checksum: string; sql: string } {
  const sql = readFileSync(path, "utf8");
  return { checksum: createHash("sha256").update(sql).digest("hex"), sql };
}

function migrate(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const knownVersions = new Set<string>(MIGRATIONS.map(({ version }) => version));
  const appliedVersions = db
    .prepare<[], MigrationRow>("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all();
  if (appliedVersions.some(({ version }) => !knownVersions.has(version))) {
    throw new VaultOperationError("vault_migration_newer_than_code");
  }

  const readApplied = db.prepare<[string], MigrationRow>(
    "SELECT version, checksum FROM schema_migrations WHERE version = ?",
  );
  const recordApplied = db.prepare<[string, string, number]>(
    "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    const { checksum, sql } = readMigration(migration.path);
    const applied = readApplied.get(migration.version);
    if (applied !== undefined) {
      if (applied.checksum !== checksum) {
        throw new VaultOperationError("vault_migration_checksum_mismatch");
      }
      continue;
    }

    const apply = db.transaction(() => {
      db.exec(sql);
      recordApplied.run(migration.version, checksum, Date.now());
    });
    apply.immediate();
  }
}

function lookupMessage(runId: Id, entityType: Code, normalizedValue: string): Buffer {
  return Buffer.concat([
    Buffer.from(runId, "utf8"),
    Buffer.from([0]),
    Buffer.from(entityType, "utf8"),
    Buffer.from([0]),
    Buffer.from(normalizedValue, "utf8"),
  ]);
}

async function loadMasterKey(
  keyProvider: KeyProvider,
  keyId: string,
  failureCode: "vault_encrypt_failed" | "vault_decrypt_failed",
): Promise<Uint8Array> {
  try {
    const key = await keyProvider.getKey(keyId);
    if (!(key instanceof Uint8Array) || key.byteLength !== KEY_PROVIDER_KEY_BYTES) {
      throw new VaultOperationError(failureCode);
    }
    return Uint8Array.from(key);
  } catch {
    throw new VaultOperationError(failureCode);
  }
}

async function deriveVaultKeys(
  keyProvider: KeyProvider,
  keyId: string,
  failureCode: "vault_encrypt_failed" | "vault_decrypt_failed",
): Promise<VaultKeys> {
  const masterKey = await loadMasterKey(keyProvider, keyId, failureCode);
  let encryption: Uint8Array | undefined;
  let lookup: Uint8Array | undefined;
  try {
    encryption = hkdfSha256(masterKey, ENCRYPTION_INFO);
    lookup = hkdfSha256(masterKey, LOOKUP_INFO);
    return { encryption, lookup };
  } catch {
    encryption?.fill(0);
    lookup?.fill(0);
    throw new VaultOperationError(failureCode);
  } finally {
    masterKey.fill(0);
  }
}

function currentKeyId(keyProvider: KeyProvider): string {
  try {
    return keyProvider.currentKeyId();
  } catch {
    throw new VaultOperationError("vault_encrypt_failed");
  }
}

/** SQLite-backed encrypted vault isolated in its own database file. */
export class SqliteVault implements VaultWriter, VaultResolver, VaultReader, VaultAdmin {
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
  ) {
    this.db = new Database(path);
    try {
      this.db.pragma("secure_delete = ON");
      this.db.pragma("busy_timeout = 5000");
      migrate(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Store a trimmed value or reuse its existing run-scoped token.
   * Lookup uses the current key id, so rotation can issue a second token for the same value.
   * Task 12.5 must query every active key id or keep the lookup key stable across rotations.
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
    let lookup = Buffer.alloc(0);

    try {
      lookup = Buffer.from(hmacSha256(keys.lookup, message));
      return this.putTransaction({
        runId,
        entityType,
        typeName,
        rawValue,
        lookup,
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
      lookup.fill(0);
    }
  }

  /** Resolve a token only within its owning run. */
  async resolve(runId: Id, token: TokenValue): Promise<string | undefined> {
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
    let rows: VaultEntryRow[];
    try {
      rows = this.db
        .prepare<[Id], VaultEntryRow>(
          "SELECT token, value_enc, key_id FROM vault_entries WHERE run_id = ? ORDER BY token",
        )
        .all(runId);
    } catch {
      throw new VaultOperationError("vault_unavailable");
    }
    return Promise.all(rows.map((row) => this.decryptEntry(runId, row)));
  }

  /** Return a monotonic version for entries ever added to a run. */
  version(runId: Id): Promise<number> {
    try {
      const row = this.db
        .prepare<[Id], { version: number }>(
          "SELECT COALESCE(SUM(next_n - 1), 0) AS version FROM vault_counters WHERE run_id = ?",
        )
        .get(runId);
      return Promise.resolve(row?.version ?? 0);
    } catch {
      return Promise.reject(new VaultOperationError("vault_unavailable"));
    }
  }

  /** Remove a run's encrypted entries without resetting token numbering. */
  purge(runId: Id): Promise<number> {
    try {
      const result = this.db.prepare<[Id]>("DELETE FROM vault_entries WHERE run_id = ?").run(runId);
      return Promise.resolve(result.changes);
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

  /** Close the dedicated SQLite connection. */
  close(): void {
    this.db.close();
  }

  private putTransaction({
    runId,
    entityType,
    typeName,
    rawValue,
    lookup,
    keyId,
    keys,
  }: PutTransactionInput): TokenValue {
    const put = this.db.transaction(() => {
      const existing = this.db
        .prepare<[Id, Code, Buffer], { token: string }>(
          "SELECT token FROM vault_entries WHERE run_id = ? AND entity_type = ? AND lookup = ?",
        )
        .get(runId, entityType, lookup);
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
          lookup,
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
        "INSERT INTO vault_entries (run_id, token, entity_type, lookup, value_enc, key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        token,
        entityType,
        lookup,
        Buffer.from(encrypted).toString("base64"),
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
    let key: Uint8Array | undefined;
    let plaintext: Uint8Array | undefined;
    try {
      key = await loadMasterKey(this.keyProvider, row.key_id, "vault_decrypt_failed");
      const encryptionKey = hkdfSha256(key, ENCRYPTION_INFO);
      key.fill(0);
      key = encryptionKey;
      const encrypted = Buffer.from(row.value_enc, "base64");
      if (encrypted.toString("base64") !== row.value_enc) {
        throw new Error("Invalid encrypted value");
      }
      plaintext = aesGcmDecrypt(key, encrypted, Buffer.from(`${runId}:${row.token}`, "utf8"));
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new VaultOperationError("vault_decrypt_failed");
    } finally {
      key?.fill(0);
      plaintext?.fill(0);
    }
  }
}
