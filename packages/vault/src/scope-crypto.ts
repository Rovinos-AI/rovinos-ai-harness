// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { aesGcmDecrypt, aesGcmEncrypt } from "@harness/crypto";
import type { Id, KeyProvider } from "@harness/schemas";
import { VaultOperationError } from "./errors.js";
import { deriveVaultKeys } from "./sqlite-crypto.js";

const SCOPE_KEY_AAD_PREFIX = "harness/vault/scope/";

/** A fresh data key and its master-key-wrapped representation. */
export interface WrappedScopeKey {
  readonly dataKey: Uint8Array;
  readonly wrappedDek: Buffer;
}

/** Wrap an existing scope key under a configured master key. */
export async function wrapScopeKey(
  keyProvider: KeyProvider,
  keyId: string,
  scopeId: Id,
  dataKey: Uint8Array,
): Promise<Buffer> {
  let keys: Awaited<ReturnType<typeof deriveVaultKeys>> | undefined;
  let wrapped: Uint8Array | undefined;
  try {
    keys = await deriveVaultKeys(keyProvider, keyId, "vault_encrypt_failed");
    const encrypted = aesGcmEncrypt(
      keys.encryption,
      dataKey,
      Buffer.from(`${SCOPE_KEY_AAD_PREFIX}${scopeId}`, "utf8"),
    );
    wrapped = encrypted;
    return Buffer.from(encrypted);
  } catch {
    throw new VaultOperationError("vault_encrypt_failed");
  } finally {
    keys?.encryption.fill(0);
    keys?.lookup.fill(0);
    wrapped?.fill(0);
  }
}

/** Generate a random 32-byte scope key and wrap it under the current vault key. */
export async function createWrappedScopeKey(
  keyProvider: KeyProvider,
  keyId: string,
  scopeId: Id,
  random: () => Uint8Array = () => randomBytes(32),
): Promise<WrappedScopeKey> {
  let generated: Uint8Array;
  try {
    generated = random();
  } catch {
    throw new VaultOperationError("vault_encrypt_failed");
  }
  if (generated.byteLength !== 32) {
    generated.fill(0);
    throw new VaultOperationError("vault_encrypt_failed");
  }
  const dataKey = Uint8Array.from(generated);
  generated.fill(0);
  try {
    return { dataKey, wrappedDek: await wrapScopeKey(keyProvider, keyId, scopeId, dataKey) };
  } catch {
    dataKey.fill(0);
    throw new VaultOperationError("vault_encrypt_failed");
  }
}

/** Unwrap a scope key without exposing provider or ciphertext details. */
export async function unwrapScopeKey(
  keyProvider: KeyProvider,
  keyId: string,
  scopeId: Id,
  wrappedDek: Uint8Array,
): Promise<Uint8Array> {
  let keys: Awaited<ReturnType<typeof deriveVaultKeys>> | undefined;
  let dataKey: Uint8Array | undefined;
  try {
    keys = await deriveVaultKeys(keyProvider, keyId, "vault_decrypt_failed");
    const unwrapped = aesGcmDecrypt(
      keys.encryption,
      wrappedDek,
      Buffer.from(`${SCOPE_KEY_AAD_PREFIX}${scopeId}`, "utf8"),
    );
    if (unwrapped.byteLength !== 32) {
      unwrapped.fill(0);
      throw new Error("Invalid scope key");
    }
    dataKey = unwrapped;
    return unwrapped;
  } catch {
    dataKey?.fill(0);
    throw new VaultOperationError("vault_decrypt_failed");
  } finally {
    keys?.encryption.fill(0);
    keys?.lookup.fill(0);
  }
}

/** Encrypt one raw value with its scope data key and token-bound associated data. */
export function encryptScopeValue(dataKey: Uint8Array, value: string, aad: string): string {
  const plaintext = Buffer.from(value, "utf8");
  let encrypted: Uint8Array | undefined;
  try {
    const ciphertext = aesGcmEncrypt(dataKey, plaintext, Buffer.from(aad, "utf8"));
    encrypted = ciphertext;
    return Buffer.from(ciphertext).toString("base64");
  } catch {
    throw new VaultOperationError("vault_encrypt_failed");
  } finally {
    plaintext.fill(0);
    encrypted?.fill(0);
  }
}

/** Decrypt one value with its scope data key and token-bound associated data. */
export function decryptScopeValue(dataKey: Uint8Array, valueEnc: string, aad: string): string {
  let plaintext: Uint8Array | undefined;
  try {
    const encrypted = Buffer.from(valueEnc, "base64");
    if (encrypted.toString("base64") !== valueEnc) {
      throw new Error("Invalid encrypted value");
    }
    plaintext = aesGcmDecrypt(dataKey, encrypted, Buffer.from(aad, "utf8"));
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new VaultOperationError("vault_decrypt_failed");
  } finally {
    plaintext?.fill(0);
  }
}
