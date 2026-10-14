// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  decodeVaultRotationCursor,
  encodeVaultRotationCursor,
  VaultKeyRowCountSchema,
  VaultReencryptBatchInputSchema,
} from "./rotate.js";

describe("vault key rotation contracts", () => {
  it("validates batch inputs and row counts with the default batch size", () => {
    expect(VaultReencryptBatchInputSchema.parse({ targetKeyId: "key-b" })).toEqual({
      targetKeyId: "key-b",
      limit: 500,
    });
    expect(
      VaultReencryptBatchInputSchema.safeParse({ targetKeyId: "key-b", limit: 0 }).success,
    ).toBe(false);
    expect(VaultKeyRowCountSchema.parse({ keyId: "key-b", count: 2 })).toEqual({
      keyId: "key-b",
      count: 2,
    });
  });

  it("round-trips stable cursors and rejects invalid cursor data", () => {
    const cursor = { runId: "A".repeat(26), token: "<EMAIL_2>" };
    expect(decodeVaultRotationCursor(encodeVaultRotationCursor(cursor))).toEqual(cursor);
    let error: unknown;
    try {
      decodeVaultRotationCursor("invalid");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "vault_unavailable" });
  });
});
