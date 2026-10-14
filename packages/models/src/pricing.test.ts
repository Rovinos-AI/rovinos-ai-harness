// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { HarnessError } from "@harness/schemas";
import { ModelUsageError } from "./errors.js";
import { calculateCostMicros, resolveModelPricing } from "./pricing.js";

describe("model pricing", () => {
  it.each([
    {
      usage: { inputTokens: 1_000, outputTokens: 500 },
      rate: { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_000_000 },
      cost: 750,
    },
    {
      usage: { inputTokens: 1, outputTokens: 1 },
      rate: { inputMicrosPerMTok: 500_000, outputMicrosPerMTok: 0 },
      cost: 1,
    },
    {
      usage: { inputTokens: 0, outputTokens: 0 },
      rate: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 },
      cost: 0,
    },
  ])("computes rounded integer micros for $usage", ({ usage, rate, cost }) => {
    expect(calculateCostMicros(usage, rate)).toBe(cost);
  });

  it("uses exact arithmetic when token-price products exceed the safe integer range", () => {
    expect(
      calculateCostMicros(
        { inputTokens: 9_000_000_000_000, outputTokens: 0 },
        { inputMicrosPerMTok: 1_000, outputMicrosPerMTok: 0 },
      ),
    ).toBe(9_000_000_000);
  });

  it.each([
    {
      usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
      rate: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 0 },
    },
    {
      usage: { inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER + 1 },
      rate: { inputMicrosPerMTok: 0, outputMicrosPerMTok: 1 },
    },
    {
      usage: { inputTokens: -1, outputTokens: 0 },
      rate: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 0 },
    },
    {
      usage: { inputTokens: 0, outputTokens: -1 },
      rate: { inputMicrosPerMTok: 0, outputMicrosPerMTok: 1 },
    },
    {
      usage: { inputTokens: 1, outputTokens: 0 },
      rate: { inputMicrosPerMTok: -1, outputMicrosPerMTok: 0 },
    },
    {
      usage: { inputTokens: 0, outputTokens: 1 },
      rate: { inputMicrosPerMTok: 0, outputMicrosPerMTok: -1 },
    },
    {
      usage: { inputTokens: 1, outputTokens: 0 },
      rate: { inputMicrosPerMTok: Number.MAX_SAFE_INTEGER + 1, outputMicrosPerMTok: 0 },
    },
  ])("rejects invalid usage or pricing with a typed error: $usage / $rate", ({ usage, rate }) => {
    let thrown: unknown;
    try {
      calculateCostMicros(usage, rate);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HarnessError);
    expect(thrown).toBeInstanceOf(ModelUsageError);
    expect(thrown).toMatchObject({ code: "model_usage_out_of_range" });
  });

  it("rejects costs that cannot be represented as safe integer micros", () => {
    expect(() =>
      calculateCostMicros(
        { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
        { inputMicrosPerMTok: Number.MAX_SAFE_INTEGER, outputMicrosPerMTok: 0 },
      ),
    ).toThrow(ModelUsageError);
  });

  it("omits costs without a configured price", () => {
    expect(calculateCostMicros({ inputTokens: 100, outputTokens: 50 }, undefined)).toBeUndefined();
  });

  it("resolves prices only by the configured provider/model key", () => {
    const pricing = {
      "sample/model-a": { inputMicrosPerMTok: 5, outputMicrosPerMTok: 8 },
    };

    expect(resolveModelPricing("sample", "model-a", pricing)).toEqual(pricing["sample/model-a"]);
    expect(resolveModelPricing("sample", "model-b", pricing)).toBeUndefined();
    expect(resolveModelPricing("sample", "model-a", undefined)).toBeUndefined();
  });
});
