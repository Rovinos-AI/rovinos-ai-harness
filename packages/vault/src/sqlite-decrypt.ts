// SPDX-License-Identifier: Apache-2.0
import { aesGcmDecrypt, hkdfSha256 } from "@harness/crypto";
import type { Id, KeyProvider } from "@harness/schemas";
import { VaultOperationError } from "./errors.js";

export const ENCRYPTION_INFO = "harness/vault/enc";

interface EncryptedEntry {
  readonly token: string;
  readonly value_enc: string;
  readonly key_id: string;
}

type LoadMasterKey = (
  keyProvider: KeyProvider,
  keyId: string,
  failureCode: "vault_decrypt_failed",
) => Promise<Uint8Array>;

/** Decrypts one SQLite vault row while clearing every transient key and plaintext buffer. */
export async function decryptSqliteEntry(
  runId: Id,
  row: EncryptedEntry,
  keyProvider: KeyProvider,
  loadMasterKey: LoadMasterKey,
): Promise<string> {
  let key: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    key = await loadMasterKey(keyProvider, row.key_id, "vault_decrypt_failed");
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
