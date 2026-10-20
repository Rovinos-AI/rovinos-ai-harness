// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { QuotaConfigSchema, QuotasConfigSchema } from "./quotas.js";

describe("QuotaConfigSchema", () => {
  it("accepts principal, role, and all supported limits", () => {
    expect(
      QuotaConfigSchema.parse({
        id: "team_daily",
        match: { requestedBy: ["token.demo"], role: ["researcher"] },
        dailyCostUsd: 12.5,
        monthlyCostUsd: 100,
        maxConcurrentRuns: 2,
        maxRunsPerHour: 10,
      }),
    ).toEqual({
      id: "team_daily",
      match: { requestedBy: ["token.demo"], role: ["researcher"] },
      dailyCostUsd: 12.5,
      monthlyCostUsd: 100,
      maxConcurrentRuns: 2,
      maxRunsPerHour: 10,
    });
  });

  it("rejects unknown fields, invalid codes, and non-positive limits", () => {
    expect(QuotaConfigSchema.safeParse({ id: "Bad", match: {} }).success).toBe(false);
    expect(QuotaConfigSchema.safeParse({ id: "quota", match: {}, extra: true }).success).toBe(
      false,
    );
    expect(
      QuotaConfigSchema.safeParse({
        id: "quota",
        match: {},
        dailyCostUsd: 0,
        maxConcurrentRuns: 1.5,
      }).success,
    ).toBe(false);
  });

  it("defaults an absent quota list and rejects duplicate quota ids", () => {
    expect(QuotasConfigSchema.parse(undefined)).toEqual([]);
    expect(
      QuotasConfigSchema.safeParse([
        { id: "same", match: {} },
        { id: "same", match: {} },
      ]).success,
    ).toBe(false);
  });
});
