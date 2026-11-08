// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  addCostValue,
  combineCostTotals,
  CostValueSchema,
  EMPTY_COST_TOTAL,
} from "./cost.js";

describe("versioned cost values and totals", () => {
  it("distinguishes known zero from unknown", () => {
    const knownZero = CostValueSchema.parse({ version: 1, state: "known", amountMicros: 0 });
    const unknown = CostValueSchema.parse({ version: 1, state: "unknown" });

    expect(addCostValue(EMPTY_COST_TOTAL, knownZero)).toMatchObject({
      state: "known",
      knownMicros: 0,
      knownCount: 1,
      unknownCount: 0,
    });
    expect(addCostValue(EMPTY_COST_TOTAL, unknown)).toMatchObject({
      state: "unknown",
      knownMicros: 0,
      unknownCount: 1,
    });
  });

  it("keeps mixed known, estimated, partial, and unknown amounts separate", () => {
    const total = [
      { version: 1, state: "known", amountMicros: 2 },
      { version: 1, state: "estimated", amountMicros: 3 },
      { version: 1, state: "partial", amountMicros: 5 },
      { version: 1, state: "unknown" },
    ].reduce((current, value) => addCostValue(current, CostValueSchema.parse(value)), EMPTY_COST_TOTAL);

    expect(total).toEqual({
      version: 1,
      state: "partial",
      knownMicros: 2,
      estimatedMicros: 3,
      partialMicros: 5,
      knownCount: 1,
      estimatedCount: 1,
      partialCount: 1,
      unknownCount: 1,
    });
  });

  it("rejects totals with overflow or inconsistent completeness", () => {
    expect(() =>
      addCostValue(EMPTY_COST_TOTAL, {
        version: 1,
        state: "known",
        amountMicros: Number.MAX_SAFE_INTEGER,
      }),
    ).not.toThrow();
    expect(() =>
      addCostValue(
        addCostValue(EMPTY_COST_TOTAL, {
          version: 1,
          state: "known",
          amountMicros: Number.MAX_SAFE_INTEGER,
        }),
        { version: 1, state: "known", amountMicros: 1 },
      ),
    ).toThrow(RangeError);
  });

  it("combines partial totals without treating missing amounts as zero", () => {
    const left = addCostValue(EMPTY_COST_TOTAL, {
      version: 1,
      state: "known",
      amountMicros: 4,
    });
    const right = addCostValue(EMPTY_COST_TOTAL, { version: 1, state: "unknown" });

    expect(combineCostTotals(left, right)).toMatchObject({
      state: "partial",
      knownMicros: 4,
      unknownCount: 1,
    });
  });
});
