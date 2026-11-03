// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { TelemetryConfigSchema } from "./telemetry.js";

describe("TelemetryConfigSchema", () => {
  it("defaults the sentinel minimum value length", () => {
    expect(TelemetryConfigSchema.parse({})).toEqual({
      sentinel: { minValueLength: 6 },
      correlation: { enabled: false },
      metrics: { enabled: true, ownership: "harness", maxSeries: 100 },
    });
  });

  it("enables correlation only when explicitly configured", () => {
    expect(TelemetryConfigSchema.parse({ correlation: { enabled: true } })).toEqual({
      sentinel: { minValueLength: 6 },
      correlation: { enabled: true },
      metrics: { enabled: true, ownership: "harness", maxSeries: 100 },
    });
  });

  it("accepts a configured minimum value length", () => {
    expect(TelemetryConfigSchema.parse({ sentinel: { minValueLength: 10 } })).toEqual({
      sentinel: { minValueLength: 10 },
      correlation: { enabled: false },
      metrics: { enabled: true, ownership: "harness", maxSeries: 100 },
    });
  });

  it("accepts an explicit development-only sentinel disable setting", () => {
    expect(TelemetryConfigSchema.parse({ sentinel: { enabled: false } })).toEqual({
      sentinel: { minValueLength: 6, enabled: false },
      correlation: { enabled: false },
      metrics: { enabled: true, ownership: "harness", maxSeries: 100 },
    });
  });

  it("supports disabled and host-owned metric pipelines with a bounded series limit", () => {
    expect(
      TelemetryConfigSchema.parse({
        metrics: { enabled: false, ownership: "host", maxSeries: 25 },
      }).metrics,
    ).toEqual({ enabled: false, ownership: "host", maxSeries: 25 });
    expect(TelemetryConfigSchema.safeParse({ metrics: { maxSeries: 1_001 } }).success).toBe(false);
  });

  it("rejects non-positive, fractional, and unknown values", () => {
    expect(TelemetryConfigSchema.safeParse({ sentinel: { minValueLength: 0 } }).success).toBe(
      false,
    );
    expect(TelemetryConfigSchema.safeParse({ sentinel: { minValueLength: 1.5 } }).success).toBe(
      false,
    );
    expect(TelemetryConfigSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(TelemetryConfigSchema.safeParse({ correlation: { enabled: "yes" } }).success).toBe(
      false,
    );
  });
});
