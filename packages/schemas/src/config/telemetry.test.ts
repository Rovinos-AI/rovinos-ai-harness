// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { TelemetryConfigSchema } from "./telemetry.js";

describe("TelemetryConfigSchema", () => {
  it("defaults the sentinel minimum value length", () => {
    expect(TelemetryConfigSchema.parse({})).toEqual({
      sentinel: { minValueLength: 6 },
      correlation: { enabled: false },
      metrics: { enabled: true, ownership: "harness", maxSeries: 100 },
      sinks: [],
      unsafe: { allowContentSinks: false },
    });
  });

  it("enables correlation only when explicitly configured", () => {
    expect(TelemetryConfigSchema.parse({ correlation: { enabled: true } })).toEqual({
      sentinel: { minValueLength: 6 },
      correlation: { enabled: true },
      metrics: { enabled: true, ownership: "harness", maxSeries: 100 },
      sinks: [],
      unsafe: { allowContentSinks: false },
    });
  });

  it("accepts a configured minimum value length", () => {
    expect(TelemetryConfigSchema.parse({ sentinel: { minValueLength: 10 } })).toEqual({
      sentinel: { minValueLength: 10 },
      correlation: { enabled: false },
      metrics: { enabled: true, ownership: "harness", maxSeries: 100 },
      sinks: [],
      unsafe: { allowContentSinks: false },
    });
  });

  it("accepts an explicit development-only sentinel disable setting", () => {
    expect(TelemetryConfigSchema.parse({ sentinel: { enabled: false } })).toEqual({
      sentinel: { minValueLength: 6, enabled: false },
      correlation: { enabled: false },
      metrics: { enabled: true, ownership: "harness", maxSeries: 100 },
      sinks: [],
      unsafe: { allowContentSinks: false },
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

  it("defaults sink policy fields and rejects duplicate or unknown sink settings", () => {
    expect(
      TelemetryConfigSchema.parse({ sinks: [{ id: "events", kind: "datadog" }] }).sinks,
    ).toEqual([
      {
        id: "events",
        kind: "datadog",
        maxClassification: "metadata",
        enabled: true,
      },
    ]);
    expect(
      TelemetryConfigSchema.safeParse({
        sinks: [
          { id: "events", kind: "datadog" },
          { id: "events", kind: "stdout" },
        ],
      }).success,
    ).toBe(false);
    expect(
      TelemetryConfigSchema.safeParse({ sinks: [{ id: "events", kind: "unknown" }] }).success,
    ).toBe(false);
  });

  it("defaults content sinks to unsafe-disabled", () => {
    expect(TelemetryConfigSchema.parse({ unsafe: {} }).unsafe).toEqual({
      allowContentSinks: false,
    });
    expect(TelemetryConfigSchema.safeParse({ unsafe: { allowContentSinks: "yes" } }).success).toBe(
      false,
    );
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
