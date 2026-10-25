// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { aesGcmDecrypt, aesGcmEncrypt } from "@rovinos/crypto";
import { HarnessError, parseJson } from "@rovinos/schemas";
import type { KeyProvider } from "@rovinos/schemas";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const StoredClientInformationSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
    client_id_issued_at: z.number().optional(),
    client_secret_expires_at: z.number().optional(),
    issuer: z.string().optional(),
    redirect_uris: z.array(z.string()).optional(),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    application_type: z.string().optional(),
    client_name: z.string().optional(),
    client_uri: z.string().optional(),
    logo_uri: z.string().optional(),
    scope: z.string().optional(),
    contacts: z.array(z.string()).optional(),
    tos_uri: z.string().optional(),
    policy_uri: z.string().optional(),
    jwks_uri: z.string().optional(),
    jwks: z.record(z.string(), z.unknown()).optional(),
    software_id: z.string().optional(),
    software_version: z.string().optional(),
    software_statement: z.string().optional(),
  })
  .strict();

const StoredTokensSchema = z
  .object({
    access_token: z.string().min(1),
    id_token: z.string().optional(),
    token_type: z.string().min(1),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
    refresh_token: z.string().optional(),
    issuer: z.string().optional(),
  })
  .strict();

/** OAuth state encrypted as one issuer-bound row in the MCP credential database. */
export const OAuthCredentialRecordSchema = z
  .object({
    issuer: z.string().optional(),
    clientInformation: StoredClientInformationSchema.optional(),
    tokens: StoredTokensSchema.optional(),
    codeVerifier: z.string().optional(),
    state: z.string().optional(),
    redirectUrl: z.url().optional(),
  })
  .strict();

/** Inferred state persisted by {@link OAuthTokenStore}. */
export type OAuthCredentialRecord = z.infer<typeof OAuthCredentialRecordSchema>;

interface CredentialRow {
  readonly key_id: string;
  readonly value_enc: Buffer;
}

/** Safe storage error that never includes token or database content. */
export class OAuthTokenStoreError extends HarnessError {
  override readonly code = "mcp_oauth_storage_failed";

  constructor() {
    super("mcp_oauth_storage_failed");
  }
}

/**
 * Stores MCP OAuth credentials in a dedicated SQLite file, encrypted with AES-GCM and bound to
 * the configured server id as associated data.
 */
export class OAuthTokenStore {
  readonly #database: Database.Database;
  readonly #keys: KeyProvider;

  private constructor(database: Database.Database, keys: KeyProvider) {
    this.#database = database;
    this.#keys = keys;
    this.#database.pragma("secure_delete = ON");
    this.#database.pragma("journal_mode = DELETE");
    this.#database.pragma("busy_timeout = 5000");
    this.#database.exec(
      "CREATE TABLE IF NOT EXISTS oauth_credentials (server_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, value_enc BLOB NOT NULL)",
    );
  }

  /**
   * Opens the credential database and restricts its directory and file permissions.
   *
   * @param path - Dedicated SQLite file path, or `:memory:` for tests.
   * @param keys - Key provider used for encryption and decryption.
   * @returns The open encrypted credential store.
   */
  static async open(path: string, keys: KeyProvider): Promise<OAuthTokenStore> {
    try {
      if (path !== ":memory:") {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await chmod(dirname(path), 0o700);
      }
      const store = new OAuthTokenStore(new Database(path), keys);
      if (path !== ":memory:") {
        await chmod(path, 0o600);
      }
      return store;
    } catch {
      throw new OAuthTokenStoreError();
    }
  }

  /** Returns decrypted credentials for one server, or `undefined` when none are stored. */
  async load(serverId: string): Promise<OAuthCredentialRecord | undefined> {
    let row: CredentialRow | undefined;
    try {
      row = this.#database
        .prepare<[string], CredentialRow>(
          "SELECT key_id, value_enc FROM oauth_credentials WHERE server_id = ?",
        )
        .get(serverId);
    } catch {
      throw new OAuthTokenStoreError();
    }
    if (row === undefined) {
      return undefined;
    }
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = aesGcmDecrypt(
        await this.#keys.getKey(row.key_id),
        row.value_enc,
        Buffer.from(serverId),
      );
      return parseJson(OAuthCredentialRecordSchema, new TextDecoder().decode(plaintext));
    } catch {
      throw new OAuthTokenStoreError();
    } finally {
      plaintext?.fill(0);
    }
  }

  /** Encrypts and stores the validated OAuth credentials for one server. */
  async save(serverId: string, value: OAuthCredentialRecord): Promise<void> {
    let plaintext: Buffer | undefined;
    let encrypted: Uint8Array | undefined;
    try {
      const validated = OAuthCredentialRecordSchema.parse(value);
      plaintext = Buffer.from(JSON.stringify(validated));
      const keyId = this.#keys.currentKeyId();
      const encryptedValue = aesGcmEncrypt(
        await this.#keys.getKey(keyId),
        plaintext,
        Buffer.from(serverId),
      );
      encrypted = encryptedValue;
      this.#database
        .prepare(
          "INSERT OR REPLACE INTO oauth_credentials (server_id, key_id, value_enc) VALUES (?, ?, ?)",
        )
        .run(serverId, keyId, Buffer.from(encryptedValue));
    } catch {
      throw new OAuthTokenStoreError();
    } finally {
      plaintext?.fill(0);
      encrypted?.fill(0);
    }
  }

  /** Deletes every stored credential for one server id. */
  delete(serverId: string): void {
    try {
      this.#database.prepare("DELETE FROM oauth_credentials WHERE server_id = ?").run(serverId);
    } catch {
      throw new OAuthTokenStoreError();
    }
  }

  /** Closes the dedicated SQLite connection. */
  close(): void {
    this.#database.close();
  }
}
