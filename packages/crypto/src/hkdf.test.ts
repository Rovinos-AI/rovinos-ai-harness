// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { hkdfSha256 } from "./index.js";

function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

describe("hkdfSha256", () => {
  it("matches the empty-salt SHA-256 known-answer vector", () => {
    const derived = hkdfSha256(new Uint8Array(22).fill(0x0b), new Uint8Array(), 42);

    expect(Buffer.from(derived).toString("hex")).toBe(
      "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
    );
  });

  it("defaults to 32 bytes and rejects invalid output lengths", () => {
    expect(hkdfSha256(new Uint8Array(32), "info").byteLength).toBe(32);
    expect(captureError(() => hkdfSha256(new Uint8Array(32), new Uint8Array(), 0))).toMatchObject({
      code: "crypto_hkdf_failed",
    });
    expect(
      captureError(() => hkdfSha256(new Uint8Array(32), new Uint8Array(), 8161)),
    ).toMatchObject({ code: "crypto_hkdf_failed" });
  });
});
