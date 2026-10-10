// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { hmacSha256 } from "./index.js";

function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

describe("hmacSha256", () => {
  it("matches the SHA-256 known-answer vector", () => {
    const digest = hmacSha256(new Uint8Array(20).fill(0x0b), Buffer.from("Hi There"));

    expect(Buffer.from(digest).toString("hex")).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("hides native crypto failures", () => {
    const invalidKey = new Proxy(new Uint8Array(1), {});

    expect(captureError(() => hmacSha256(invalidKey, new Uint8Array()))).toMatchObject({
      code: "crypto_hmac_failed",
      message: "Message authentication failed",
    });
  });
});
