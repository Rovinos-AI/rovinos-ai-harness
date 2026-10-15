// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { VaultConfigSchema } from "./vault.js";

describe("VaultConfigSchema", () => {
  it("defaults the post-completion grace period to seven days", () => {
    expect(VaultConfigSchema.parse({})).toEqual({ backend: "sqlite", purgeAfterDays: 7 });
  });

  it("accepts positive integer days and coerces string configuration", () => {
    expect(VaultConfigSchema.parse({ purgeAfterDays: "30" })).toEqual({
      backend: "sqlite",
      purgeAfterDays: 30,
    });
  });

  it("requires a SecretRef URL only for the Postgres backend", () => {
    expect(
      VaultConfigSchema.parse({ backend: "postgres", postgres: { url: "env:VAULT_DATABASE_URL" } }),
    ).toMatchObject({ backend: "postgres", postgres: { url: "env:VAULT_DATABASE_URL" } });
    expect(() => VaultConfigSchema.parse({ backend: "postgres" })).toThrow();
    expect(() =>
      VaultConfigSchema.parse({
        backend: "postgres",
        postgres: { url: "******host/db" },
      }),
    ).toThrow();
    expect(() =>
      VaultConfigSchema.parse({ backend: "sqlite", postgres: { url: "env:VAULT_DATABASE_URL" } }),
    ).toThrow();
  });

  it("rejects invalid retention settings and unknown properties", () => {
    for (const purgeAfterDays of [0, -1, 1.5, Number.NaN]) {
      expect(() => VaultConfigSchema.parse({ purgeAfterDays })).toThrow();
    }
    expect(() => VaultConfigSchema.parse({ unexpected: true })).toThrow();
  });
});
