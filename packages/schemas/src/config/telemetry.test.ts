// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { TelemetryConfigSchema } from "./telemetry.js";

describe("TelemetryConfigSchema", () => {
  it("defaults the sentinel minimum value length", () => {
    expect(TelemetryConfigSchema.parse({})).toEqual({
      sentinel: { minValueLength: 6 },
    });
  });

  it("accepts a configured minimum value length", () => {
    expect(TelemetryConfigSchema.parse({ sentinel: { minValueLength: 10 } })).toEqual({
      sentinel: { minValueLength: 10 },
    });
  });

  it("rejects non-positive, fractional, and unknown values", () => {
    expect(TelemetryConfigSchema.safeParse({ sentinel: { minValueLength: 0 } }).success).toBe(
      false,
    );
    expect(TelemetryConfigSchema.safeParse({ sentinel: { minValueLength: 1.5 } }).success).toBe(
      false,
    );
    expect(TelemetryConfigSchema.safeParse({ unexpected: true }).success).toBe(false);
  });
});
