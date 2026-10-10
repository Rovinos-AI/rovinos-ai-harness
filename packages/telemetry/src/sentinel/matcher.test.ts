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
    expect(build).not.toHaveBeenCalled();
    expect("findAll" in matcher).toBe(false);
  });

  it("matches vault values case-sensitively without returning match text", () => {
    const matcher = SentinelMatcher.forValues(["Raw-Value"]);

    expect(matcher.hasMatch("before Raw-Value after")).toBe(true);
    expect(matcher.hasMatch("raw-value")).toBe(false);
  });

  it("uses supplied variants", () => {
    const matcher = SentinelMatcher.forValues(["Raw-Value"], (value) => [
      value,
      value.toLowerCase(),
    ]);

    expect(matcher.hasMatch("raw-value")).toBe(true);
  });
});
