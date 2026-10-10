// SPDX-License-Identifier: Apache-2.0
import { hkdfSync } from "node:crypto";
import { CryptoError } from "./errors.js";

const HKDF_SHA256_MAX_BYTES = 255 * 32;

/** Derive key material with HKDF-SHA-256 and an empty salt. */
export function hkdfSha256(
  masterKey: Uint8Array,
  info: string | Uint8Array,
  length = 32,
): Uint8Array {
  const inputKey = Buffer.from(masterKey);
  try {
    if (!Number.isSafeInteger(length) || length < 1 || length > HKDF_SHA256_MAX_BYTES) {
      throw new Error("Invalid output length");
    }
    const infoBytes = typeof info === "string" ? Buffer.from(info, "utf8") : info;
    return new Uint8Array(hkdfSync("sha256", inputKey, Buffer.alloc(0), infoBytes, length));
  } catch {
    throw new CryptoError("crypto_hkdf_failed");
  } finally {
    inputKey.fill(0);
  }
}
