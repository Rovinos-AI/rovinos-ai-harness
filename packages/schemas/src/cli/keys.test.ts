// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { KeyRetireResultSchema, KeyRotationResultSchema } from "./keys.js";

describe("key command result schemas", () => {
  it("accepts nonnegative integer rotation counts", () => {
    expect(KeyRotationResultSchema.parse({ vaultProcessed: 2, storeProcessed: 3 })).toEqual({
      vaultProcessed: 2,
      storeProcessed: 3,
    });
    expect(
      KeyRotationResultSchema.safeParse({ vaultProcessed: -1, storeProcessed: 0 }).success,
    ).toBe(false);
  });

  it("validates safe-to-remove results and key identifiers", () => {
    expect(KeyRetireResultSchema.parse({ keyId: "key-a", status: "safe_to_remove" })).toEqual({
      keyId: "key-a",
      status: "safe_to_remove",
    });
    expect(KeyRetireResultSchema.safeParse({ keyId: "key-a", status: "retired" }).success).toBe(
      false,
    );
  });
});
