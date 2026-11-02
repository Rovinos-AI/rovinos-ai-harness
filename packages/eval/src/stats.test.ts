// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { bootstrapMeanDifference, fisherExactTest, holmBonferroni, SeededRandom } from "./stats.js";

describe("evaluation statistics", () => {
  it("matches two-sided Fisher exact reference tables", () => {
    expect(fisherExactTest({ passedA: 1, failedA: 9, passedB: 11, failedB: 3 })).toBeCloseTo(
      0.002759456,
      8,
    );
    expect(fisherExactTest({ passedA: 5, failedA: 5, passedB: 5, failedB: 5 })).toBeCloseTo(1, 12);
  });

  it("produces reproducible bootstrap intervals with sensible synthetic coverage", () => {
    const sampleA = Array.from({ length: 30 }, (_, index) => index % 4);
    const sampleB = Array.from({ length: 30 }, (_, index) => (index % 4) + 2);
    const first = bootstrapMeanDifference(sampleA, sampleB, 42);
    expect(bootstrapMeanDifference(sampleA, sampleB, 42)).toEqual(first);
    expect(first.delta).toBeCloseTo(2, 12);
    expect(first.ciLow).toBeLessThan(2);
    expect(first.ciHigh).toBeGreaterThan(2);
    expect(bootstrapMeanDifference(sampleA, sampleA, 42).ciLow).toBeLessThanOrEqual(0);
    expect(bootstrapMeanDifference(sampleA, sampleA, 42).ciHigh).toBeGreaterThanOrEqual(0);
  });

  it("applies Holm-Bonferroni correction in original order", () => {
    expect(holmBonferroni([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    expect(holmBonferroni([])).toEqual([]);
  });

  it("keeps the seeded random stream deterministic, including a zero seed", () => {
    const first = new SeededRandom(0);
    const second = new SeededRandom(0);
    expect(Array.from({ length: 4 }, () => first.next())).toEqual(
      Array.from({ length: 4 }, () => second.next()),
    );
  });
});
