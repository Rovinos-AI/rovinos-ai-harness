// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { TelemetryConfigSchema } from "./telemetry.js";

describe("TelemetryConfigSchema", () => {
  it("defaults the sentinel minimum value length", () => {
    expect(TelemetryConfigSchema.parse({})).toEqual({
      sentinel: { minValueLength: 6 },
      correlation: { enabled: false },
    });
  });

  it("enables correlation only when explicitly configured", () => {
    expect(TelemetryConfigSchema.parse({ correlation: { enabled: true } })).toEqual({
      sentinel: { minValueLength: 6 },
      correlation: { enabled: true },
    });
  });

  it("accepts a configured minimum value length", () => {
    expect(TelemetryConfigSchema.parse({ sentinel: { minValueLength: 10 } })).toEqual({
      sentinel: { minValueLength: 10 },
      correlation: { enabled: false },
    });
  });

  it("accepts an explicit development-only sentinel disable setting", () => {
    expect(TelemetryConfigSchema.parse({ sentinel: { enabled: false } })).toEqual({
      sentinel: { minValueLength: 6, enabled: false },
      correlation: { enabled: false },
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
    expect(TelemetryConfigSchema.safeParse({ correlation: { enabled: "yes" } }).success).toBe(
      false,
    );
  });
});
