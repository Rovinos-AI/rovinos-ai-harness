// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AhoCorasick } from "./aho-corasick.js";
import { SentinelMatcher } from "./matcher.js";

describe("SentinelMatcher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips automaton construction and scanning when the vault is empty", () => {
    const build = vi.spyOn(AhoCorasick, "build");
    const matcher = SentinelMatcher.forValues([]);

    expect(matcher.hasMatch("anything")).toBe(false);
    expect(matcher.findAll("anything")).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect("findAll" in matcher).toBe(true);
  });

  it("matches vault values case-sensitively without returning match text", () => {
    const matcher = SentinelMatcher.forValues(["Raw-Value"]);

    expect(matcher.hasMatch("before Raw-Value after")).toBe(true);
    expect(matcher.hasMatch("raw-value")).toBe(false);
    expect(matcher.findAll("before Raw-Value after")).toEqual([{ patternIndex: 0 }]);
    expect(JSON.stringify(matcher.findAll("before Raw-Value after"))).not.toContain("Raw-Value");
  });

  it("uses supplied variants", () => {
    const matcher = SentinelMatcher.forValues(["Raw-Value"], (value) => [
      value,
      value.toLowerCase(),
    ]);

    expect(matcher.hasMatch("raw-value")).toBe(true);
  });

  it("drops empty and duplicate variants", () => {
    const build = vi.spyOn(AhoCorasick, "build");
    const matcher = SentinelMatcher.forValues(["Raw-Value"], (value) => ["", value, value]);

    expect(matcher.hasMatch("before Raw-Value after")).toBe(true);
    expect(build).toHaveBeenCalledWith(["Raw-Value"]);
  });

  it("keeps the empty-pattern fast path when all variants are empty", () => {
    const build = vi.spyOn(AhoCorasick, "build");
    const matcher = SentinelMatcher.forValues(["Raw-Value"], () => ["", ""]);

    expect(matcher.hasMatch("anything")).toBe(false);
    expect(build).not.toHaveBeenCalled();
  });

  it("handles a large variant array without spreading into a function call", () => {
    const variants = Array.from({ length: 200_000 }, () => "Raw-Value");
    const matcher = SentinelMatcher.forValues(["Raw-Value"], () => variants);

    expect(matcher.hasMatch("Raw-Value")).toBe(true);
  });
});
