// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { resolveOverlaps } from "../index.js";
import type { Detection } from "../index.js";

function range(start: number, end: number, detectorId = "a", confidence = 1): Detection {
  return { start, end, detectorId, confidence, entityType: "email" };
}

describe("resolveOverlaps", () => {
  it.each([
    { input: [], expected: [] },
    { input: [range(8, 12), range(0, 8)], expected: [range(0, 8), range(8, 12)] },
    { input: [range(0, 5), range(2, 10)], expected: [range(2, 10)] },
    { input: [range(0, 10), range(2, 4)], expected: [range(0, 10)] },
    { input: [range(0, 5, "a", 0.8), range(1, 6, "b", 0.9)], expected: [range(1, 6, "b", 0.9)] },
    { input: [range(0, 5, "b"), range(1, 6, "a")], expected: [range(1, 6, "a")] },
    { input: [range(0, 5), range(1, 6)], expected: [range(0, 5)] },
    { input: [range(0, 5), range(0, 5)], expected: [range(0, 5)] },
    { input: [range(0, 8), range(6, 12), range(10, 18)], expected: [range(0, 8), range(10, 18)] },
    { input: [range(0, 5), range(4, 12), range(11, 20)], expected: [range(11, 20)] },
  ])("resolves $input", ({ input, expected }) => {
    const before = structuredClone(input);
    expect(resolveOverlaps(input)).toEqual(expected);
    expect(input).toEqual(before);
    expect(resolveOverlaps([...input].reverse())).toEqual(expected);
  });

  it("rejects malformed plugin output", () => {
    expect(() => resolveOverlaps([range(5, 2)])).toThrow();
    expect(() => resolveOverlaps([range(0, 5, "a", 2)])).toThrow();
  });
});
