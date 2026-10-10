// SPDX-License-Identifier: Apache-2.0
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CryptoError } from "./errors.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypt with AES-256-GCM, returning the fresh IV followed by ciphertext and tag. */
export function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  try {
    if (key.byteLength !== KEY_BYTES) {
      throw new Error("Invalid key length");
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Uint8Array.from(Buffer.concat([iv, ciphertext, cipher.getAuthTag()]));
  } catch {
    throw new CryptoError("crypto_encrypt_failed");
  }
}

/** Decrypt an IV || ciphertext || tag blob, authenticating its associated data. */
export function aesGcmDecrypt(key: Uint8Array, encrypted: Uint8Array, aad: Uint8Array): Uint8Array {
  try {
    if (key.byteLength !== KEY_BYTES || encrypted.byteLength < IV_BYTES + TAG_BYTES) {
      throw new Error("Invalid encrypted data");
    }
    const iv = encrypted.subarray(0, IV_BYTES);
    const authTag = encrypted.subarray(encrypted.byteLength - TAG_BYTES);
    const ciphertext = encrypted.subarray(IV_BYTES, encrypted.byteLength - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const result = Uint8Array.from(plaintext);
    plaintext.fill(0);
    return result;
  } catch {
    throw new CryptoError("crypto_decrypt_failed");
  }
}
