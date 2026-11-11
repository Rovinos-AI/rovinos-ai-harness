// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { RateLimitsConfigSchema } from "./rate-limits.js";

describe("RateLimitsConfigSchema", () => {
  it("defaults to process-local limits and local fallback", () => {
    expect(RateLimitsConfigSchema.parse({})).toEqual({
      backend: "memory",
      onUnavailable: "local",
    });
  });

  it("accepts Postgres with strict denial when unavailable", () => {
    expect(RateLimitsConfigSchema.parse({ backend: "postgres", onUnavailable: "deny" })).toEqual({
      backend: "postgres",
      onUnavailable: "deny",
    });
  });

  it("requires a secret reference for Redis and defaults its key prefix", () => {
    expect(
      RateLimitsConfigSchema.parse({
        backend: "redis",
        redis: { url: "env:HARNESS_REDIS_URL" },
      }),
    ).toEqual({
      backend: "redis",
      onUnavailable: "local",
      redis: { url: "env:HARNESS_REDIS_URL", keyPrefix: "harness" },
    });
    expect(() =>
      RateLimitsConfigSchema.parse({
        backend: "memory",
        redis: { url: "env:HARNESS_REDIS_URL" },
      }),
    ).toThrow();
    expect(() => RateLimitsConfigSchema.parse({ backend: "redis" })).toThrow();
  });

  it("rejects unknown options and backend names", () => {
    expect(() => RateLimitsConfigSchema.parse({ backend: "redis", extra: true })).toThrow();
    expect(() => RateLimitsConfigSchema.parse({ backend: "unknown" })).toThrow();
  });
});
