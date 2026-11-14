// SPDX-License-Identifier: Apache-2.0
import type { ModelPricingRate } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { boundedSpendEstimate } from "./strict-spend.js";

describe("boundedSpendEstimate", () => {
  const rate: ModelPricingRate = {
    inputMicrosPerMTok: 100,
    outputMicrosPerMTok: 300,
    cacheReadMicrosPerMTok: 500,
    maxInputTokens: 10_000,
    maxOutputTokens: 1_000,
  };

  it("uses configured ceilings, the highest input rate, and rounds up micros", () => {
    expect(boundedSpendEstimate(rate, 9_000)).toEqual({
      estimatedMicros: 6,
      maxInputTokens: 10_000,
      maxOutputTokens: 1_000,
    });
  });

  it("rejects missing token ceilings and unbounded input estimates", () => {
    const missingInput = { ...rate };
    delete missingInput.maxInputTokens;
    const missingOutput = { ...rate };
    delete missingOutput.maxOutputTokens;
    for (const [pricing, input] of [
      [missingInput, 1],
      [missingOutput, 1],
      [rate, 10_001],
      [rate, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(() => boundedSpendEstimate(pricing, input)).toThrow(
        expect.objectContaining({ code: "spend_reservation_estimate_missing" }),
      );
    }
  });

  it("rejects estimates outside safe integer micro-dollars", () => {
    expect(() =>
      boundedSpendEstimate(
        {
          ...rate,
          inputMicrosPerMTok: Number.MAX_SAFE_INTEGER,
          cacheReadMicrosPerMTok: undefined,
          maxInputTokens: Number.MAX_SAFE_INTEGER,
          maxOutputTokens: 1,
        },
        1,
      ),
    ).toThrow(expect.objectContaining({ code: "spend_reservation_estimate_missing" }));
  });
});
