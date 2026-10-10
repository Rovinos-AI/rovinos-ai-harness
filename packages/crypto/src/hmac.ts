// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import { CryptoError } from "./errors.js";

/** Calculate an HMAC-SHA-256 digest. */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  try {
    return createHmac("sha256", key).update(data).digest();
  } catch {
    throw new CryptoError("crypto_hmac_failed");
  }
}
