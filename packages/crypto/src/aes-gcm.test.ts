// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { aesGcmDecrypt, aesGcmEncrypt } from "./index.js";

const key = new Uint8Array(32).fill(7);
const aad = Buffer.from("run:token", "utf8");

function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

describe("AES-GCM helpers", () => {
  it("round-trips empty and non-empty plaintext", () => {
    const message = Buffer.from("synthetic content", "utf8");
    const encrypted = aesGcmEncrypt(key, message, aad);

    expect(encrypted.byteLength).toBe(12 + message.byteLength + 16);
    expect(aesGcmDecrypt(key, encrypted, aad)).toEqual(Uint8Array.from(message));

    const empty = aesGcmEncrypt(key, new Uint8Array(), aad);
    expect(aesGcmDecrypt(key, empty, aad)).toEqual(new Uint8Array());
  });

  it("uses a fresh IV and rejects wrong keys, AAD, and modified ciphertext", () => {
    const first = aesGcmEncrypt(key, Buffer.from("same"), aad);
    const second = aesGcmEncrypt(key, Buffer.from("same"), aad);
    expect(first).not.toEqual(second);

    expect(captureError(() => aesGcmDecrypt(new Uint8Array(16), first, aad))).toMatchObject({
      code: "crypto_decrypt_failed",
    });
    expect(captureError(() => aesGcmDecrypt(key, first, Buffer.from("other")))).toMatchObject({
      code: "crypto_decrypt_failed",
    });

    const modified = Uint8Array.from(first);
    const byte = modified.at(12);
    if (byte === undefined) {
      throw new Error("Expected encrypted content");
    }
    modified[12] = byte ^ 1;
    expect(captureError(() => aesGcmDecrypt(key, modified, aad))).toMatchObject({
      code: "crypto_decrypt_failed",
    });
  });

  it("rejects invalid encryption keys without native error details", () => {
    expect(
      captureError(() => aesGcmEncrypt(new Uint8Array(16), new Uint8Array(), aad)),
    ).toMatchObject({ code: "crypto_encrypt_failed", message: "Encryption failed" });
  });
});
