// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { StoreConfigSchema, StoreRetentionConfigSchema } from "./store.js";

describe("StoreConfigSchema", () => {
  it("leaves retention disabled until configured", () => {
    expect(StoreConfigSchema.parse({})).toEqual({});
  });

  it("parses run and snapshot retention overrides", () => {
    expect(
      StoreConfigSchema.parse({
        retention: { completedRunsDays: "30", failedRunsDays: 60, snapshotKeep: "3" },
      }),
    ).toEqual({
      retention: { completedRunsDays: 30, failedRunsDays: 60, snapshotKeep: 3 },
    });
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
        unrecognized: true,
      }),
    ).toThrow();
    expect(() => StoreConfigSchema.parse({ unrecognized: true })).toThrow();
  });
});
