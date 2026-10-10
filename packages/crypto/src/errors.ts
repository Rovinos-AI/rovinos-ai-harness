// SPDX-License-Identifier: Apache-2.0

/** Stable, detail-free failure codes for shared cryptographic operations. */
export type CryptoErrorCode =
  "crypto_encrypt_failed" | "crypto_decrypt_failed" | "crypto_hkdf_failed" | "crypto_hmac_failed";

const ERROR_MESSAGES: Record<CryptoErrorCode, string> = {
  crypto_encrypt_failed: "Encryption failed",
  crypto_decrypt_failed: "Decryption failed",
  crypto_hkdf_failed: "Key derivation failed",
  crypto_hmac_failed: "Message authentication failed",
};

/** A cryptographic failure that does not retain native error details. */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CryptoError";
    this.code = code;
  }
}
