// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { VaultValueEntrySchema } from "./vault-value-entry.js";

describe("VaultValueEntrySchema", () => {
  it("validates the in-memory value and metadata-only entity type", () => {
    expect(
      VaultValueEntrySchema.parse({ entityType: "email", rawValue: "alice@example.test" }),
    ).toEqual({ entityType: "email", rawValue: "alice@example.test" });
  });

  it("rejects invalid and additional fields", () => {
    expect(
      VaultValueEntrySchema.safeParse({ entityType: "INVALID CODE", rawValue: "value" }).success,
    ).toBe(false);
    expect(
      VaultValueEntrySchema.safeParse({
        entityType: "email",
        rawValue: "value",
        token: "<EMAIL_1>",
      }).success,
    ).toBe(false);
  });
});
