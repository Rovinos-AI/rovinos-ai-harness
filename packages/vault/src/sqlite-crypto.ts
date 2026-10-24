// SPDX-License-Identifier: Apache-2.0
import { hkdfSha256 } from "@rovinos/crypto";
import { KEY_PROVIDER_KEY_BYTES, type Code, type Id, type KeyProvider } from "@rovinos/schemas";
import { VaultOperationError } from "./errors.js";
import { ENCRYPTION_INFO } from "./sqlite-decrypt.js";

const LOOKUP_INFO = "harness/vault/lookup";

/** Derived keys for a single configured vault key version. */
export interface VaultKeys {
  /** Derived encryption key, cleared after use. */
  encryption: Uint8Array;
  /** Derived lookup HMAC key, cleared after use. */
  lookup: Uint8Array;
}

/** Build the run- and entity-scoped message used for keyed lookup HMACs. */
export function lookupMessage(runId: Id, entityType: Code, normalizedValue: string): Buffer {
  return Buffer.concat([
    Buffer.from(runId, "utf8"),
    Buffer.from([0]),
    Buffer.from(entityType, "utf8"),
    Buffer.from([0]),
    Buffer.from(normalizedValue, "utf8"),
  ]);
}

/** Load and detach validated master key material, mapping provider errors to a closed code. */
export async function loadMasterKey(
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

/** Derive and return the vault encryption and lookup keys for one configured key id. */
export async function deriveVaultKeys(
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

/** Read the configured current key id and map provider failures to a vault error. */
export function currentKeyId(keyProvider: KeyProvider): string {
  try {
    return keyProvider.currentKeyId();
  } catch {
    throw new VaultOperationError("vault_encrypt_failed");
  }
}
