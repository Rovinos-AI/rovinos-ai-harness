// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { StoreConfigSchema, StoreRetentionConfigSchema } from "./store.js";

describe("StoreConfigSchema", () => {
  it("leaves retention disabled until configured", () => {
    expect(StoreConfigSchema.parse({})).toEqual({});
  });

  it("parses run retention windows", () => {
    expect(
      StoreConfigSchema.parse({
        retention: { completedRunsDays: "30", failedRunsDays: 60 },
      }),
    ).toEqual({
      retention: { completedRunsDays: 30, failedRunsDays: 60 },
    });
  });

  it("parses snapshot retention independently from run retention", () => {
    expect(StoreConfigSchema.parse({ snapshotKeep: 2 })).toEqual({ snapshotKeep: 2 });
    expect(() => StoreConfigSchema.parse({ snapshotKeep: 0 })).toThrow();
  });

  it("selects SQLite by default and requires a secret reference for Postgres", () => {
    expect(StoreConfigSchema.parse({ dialect: "sqlite" })).toEqual({ dialect: "sqlite" });
    expect(
      StoreConfigSchema.parse({
        dialect: "postgres",
        connectionString: "env:HARNESS_STORE_URL",
      }),
    ).toEqual({
      dialect: "postgres",
      connectionString: "env:HARNESS_STORE_URL",
    });
    expect(() => StoreConfigSchema.parse({ dialect: "postgres" })).toThrow();
    expect(() =>
      StoreConfigSchema.parse({
        dialect: "sqlite",
        connectionString: "env:HARNESS_STORE_URL",
      }),
    ).toThrow();
    expect(() =>
      StoreConfigSchema.parse({
        dialect: "postgres",
        connectionString: "******localhost/harness",
      }),
    ).toThrow();
  });

  it("rejects invalid values and unknown settings", () => {
    expect(() =>
      StoreRetentionConfigSchema.parse({
        completedRunsDays: 0,
        failedRunsDays: 1,
      }),
    ).toThrow();
    expect(() =>
      StoreRetentionConfigSchema.parse({
        completedRunsDays: 1,
        failedRunsDays: 1,
        snapshotKeep: 5,
      }),
    ).toThrow();
    expect(() => StoreConfigSchema.parse({ unrecognized: true })).toThrow();
  });
});
