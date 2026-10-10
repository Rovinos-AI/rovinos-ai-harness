// SPDX-License-Identifier: Apache-2.0
import { performance } from "node:perf_hooks";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AhoCorasick, AhoCorasickError } from "./aho-corasick.js";

function errorCodeOf(action: () => void): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof AhoCorasickError ? error.code : undefined;
  }
  return undefined;
}

describe("AhoCorasick", () => {
  it("matches the text.includes oracle for 1,000 generated cases", () => {
    const result = fc.check(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 10 }),
        fc.string({ maxLength: 80 }),
        (patterns, text) =>
          AhoCorasick.build(patterns).hasMatch(text) ===
          patterns.some((pattern) => text.includes(pattern)),
      ),
      { numRuns: 1_000 },
    );
    expect(result.failed).toBe(false);
  });

  it("reports nested, overlapping, and duplicate patterns", () => {
    const matches = AhoCorasick.build(["a", "aa", "aaa", "aa"])
      .findAll("aaaa")
      .sort((left, right) => {
        if (left.start !== right.start) {
          return left.start - right.start;
        }
        return left.patternIndex - right.patternIndex;
      });

    expect(matches).toEqual([
      { patternIndex: 0, start: 0, end: 1 },
      { patternIndex: 1, start: 0, end: 2 },
      { patternIndex: 2, start: 0, end: 3 },
      { patternIndex: 3, start: 0, end: 2 },
      { patternIndex: 0, start: 1, end: 2 },
      { patternIndex: 1, start: 1, end: 3 },
      { patternIndex: 2, start: 1, end: 4 },
      { patternIndex: 3, start: 1, end: 3 },
      { patternIndex: 0, start: 2, end: 3 },
      { patternIndex: 1, start: 2, end: 4 },
      { patternIndex: 3, start: 2, end: 4 },
      { patternIndex: 0, start: 3, end: 4 },
    ]);
  });

  it("uses UTF-16 code-unit offsets for surrogate pairs", () => {
    expect(AhoCorasick.build(["🧪"]).findAll("x🧪y")).toEqual([
      { patternIndex: 0, start: 1, end: 3 },
    ]);
  });

  it("does not match empty patterns", () => {
    expect(errorCodeOf(() => AhoCorasick.build([""]))).toBe("sentinel_pattern_empty");
    expect(AhoCorasick.build([]).hasMatch("text")).toBe(false);
  });

  it("enforces the total pattern character limit", () => {
    expect(errorCodeOf(() => AhoCorasick.build(["x".repeat(1_000_001)]))).toBe(
      "sentinel_patterns_too_large",
    );
  });

  it("scans 10,000 patterns against 1 MB within the performance budget", () => {
    const patterns = Array.from(
      { length: 10_000 },
      (_, index) => `${"a".repeat(9)}${index.toString(36).toUpperCase().padStart(3, "0")}`,
    );
    const text = "a".repeat(1_000_000);
    const startedAt = performance.now();
    const matcher = AhoCorasick.build(patterns);
    expect(matcher.hasMatch(text)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
