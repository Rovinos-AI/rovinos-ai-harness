// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { StoreMigrateResultSchema, StorePurgeResultSchema } from "./store.js";

describe("store CLI result schemas", () => {
  it("accepts migration output with applied and pending versions", () => {
    expect(StoreMigrateResultSchema.parse({ applied: ["0001"], pending: [] })).toEqual({
      applied: ["0001"],
      pending: [],
    });
  });

  it("rejects malformed migration versions and unknown result fields", () => {
    expect(() => StoreMigrateResultSchema.parse({ applied: [], pending: ["latest"] })).toThrow();
    expect(() =>
      StoreMigrateResultSchema.parse({ applied: [], pending: [], message: "private" }),
    ).toThrow();
  });

  it("accepts only non-negative purge counts", () => {
    expect(
      StorePurgeResultSchema.parse({
        examined: 2,
        purged: 1,
        skippedActive: 1,
        hookFailures: 0,
      }),
    ).toEqual({ examined: 2, purged: 1, skippedActive: 1, hookFailures: 0 });
    expect(() =>
      StorePurgeResultSchema.parse({
        examined: 0,
        purged: -1,
        skippedActive: 0,
        hookFailures: 0,
      }),
    ).toThrow();
  });
});
