// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { KeysConfigSchema } from "./keys.js";

describe("KeysConfigSchema", () => {
  it("accepts a current key and historical key versions by secret reference", () => {
    expect(
      KeysConfigSchema.parse({
        currentKeyId: "new",
        keys: [
          { id: "old", secret: "env:OLD_KEY" },
          { id: "new", secret: "file:/run/secrets/new-key" },
        ],
      }),
    ).toEqual({
      currentKeyId: "new",
      keys: [
        { id: "old", secret: "env:OLD_KEY" },
        { id: "new", secret: "file:/run/secrets/new-key" },
      ],
    });
  });

  it("rejects inline secrets, duplicate key ids, and unknown properties", () => {
    expect(
      KeysConfigSchema.safeParse({
        currentKeyId: "key",
        keys: [
          { id: "key", secret: "inline-secret" },
          { id: "key", secret: "env:KEY" },
        ],
        extra: true,
      }).success,
    ).toBe(false);
  });
});
