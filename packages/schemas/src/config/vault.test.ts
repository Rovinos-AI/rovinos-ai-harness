// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { VaultConfigSchema } from "./vault.js";

describe("VaultConfigSchema", () => {
  it("defaults the post-completion grace period to seven days", () => {
    expect(VaultConfigSchema.parse({})).toEqual({ purgeAfterDays: 7 });
  });

  it("accepts positive integer days and coerces string configuration", () => {
    expect(VaultConfigSchema.parse({ purgeAfterDays: "30" })).toEqual({
      purgeAfterDays: 30,
    });
  });

  it("rejects invalid retention settings and unknown properties", () => {
    for (const purgeAfterDays of [0, -1, 1.5, Number.NaN]) {
      expect(() => VaultConfigSchema.parse({ purgeAfterDays })).toThrow();
    }
    expect(() => VaultConfigSchema.parse({ unexpected: true })).toThrow();
  });
});
