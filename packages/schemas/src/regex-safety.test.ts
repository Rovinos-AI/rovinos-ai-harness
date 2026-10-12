// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { isRegexSafePattern } from "./regex-safety.js";

describe("isRegexSafePattern", () => {
  it.each([
    "(a+)+$",
    "(a{1,4}){2}",
    "(a|aa){2}",
    "a*a*",
    "a{1,}",
    "a{1,",
    "(?=a)a",
    "(a)\\1",
    "a{257}",
    "a?a?",
    "a{1,3}a{1,3}",
    "\\p{L}{2}",
    "(a)?",
  ])("rejects unsafe pattern %s", (pattern) => {
    expect(isRegexSafePattern(pattern)).toBe(false);
  });

  it.each(["(?:ab)\\d{2}", "(ab)\\d{2}", "[+*?()]{2}", "\\+\\d{2}", "a{1,3}", "ab?", "a{2,2}"])(
    "accepts safe pattern %s",
    (pattern) => {
      expect(isRegexSafePattern(pattern)).toBe(true);
    },
  );

  it("screens operators inside and outside character classes", () => {
    expect(isRegexSafePattern("[a-z]+")).toBe(false);
    expect(isRegexSafePattern("[a-z]{2}")).toBe(true);
    expect(isRegexSafePattern("a\\+b")).toBe(true);
  });
});
