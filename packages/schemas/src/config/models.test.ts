// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ModelRetryConfigSchema, ModelsConfigSchema } from "./models.js";

describe("ModelsConfigSchema", () => {
  it("defaults retry and concurrency policies", () => {
    expect(ModelsConfigSchema.parse({})).toEqual({
      retry: {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 20_000,
        timeoutMs: 120_000,
      },
      maxConcurrent: 4,
    });
  });

  it("accepts configured retry overrides", () => {
    expect(
      ModelsConfigSchema.parse({
        retry: { maxAttempts: "5", timeoutMs: "2000" },
        maxConcurrent: "2",
      }),
    ).toEqual({
      retry: {
        maxAttempts: 5,
        baseDelayMs: 500,
        maxDelayMs: 20_000,
        timeoutMs: 2_000,
      },
      maxConcurrent: 2,
    });
  });

  it("rejects invalid retry values and unknown settings", () => {
    expect(() => ModelRetryConfigSchema.parse({ maxAttempts: 0 })).toThrow();
    expect(() => ModelsConfigSchema.parse({ retry: { unrecognized: true } })).toThrow();
  });
});
