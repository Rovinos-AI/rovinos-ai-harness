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

  it("requires a non-empty key list and a configured current key", () => {
    const result = KeysConfigSchema.safeParse({
      currentKeyId: "missing",
      keys: [{ id: "previous", secret: "env:PREVIOUS_KEY" }],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(
      result.error.issues.some(
        (issue) =>
          issue.code === "custom" &&
          issue.path.join(".") === "currentKeyId" &&
          issue.params?.errorCode === "key_current_missing",
      ),
    ).toBe(true);
    expect(KeysConfigSchema.safeParse({ currentKeyId: "primary", keys: [] }).success).toBe(false);
  });

  it("reserves the ephemeral identifier for development-only keys", () => {
    const result = KeysConfigSchema.safeParse({
      currentKeyId: "ephemeral",
      keys: [{ id: "ephemeral", secret: "env:KEY" }],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(
      result.error.issues.some(
        (issue) =>
          issue.code === "custom" &&
          issue.path.join(".") === "keys.0.id" &&
          issue.params?.errorCode === "key_id_reserved",
      ),
    ).toBe(true);
  });
});
