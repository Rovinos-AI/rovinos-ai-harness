// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { normalize } from "./normalize.js";

describe("normalize", () => {
  it("trims and applies Unicode NFKC", () => {
    expect(normalize("name", "  Ａｌｉｃｅ  ")).toBe("Alice");
  });

  it("lowercases email identities", () => {
    expect(normalize("email", " Alice@Example.test ")).toBe("alice@example.test");
  });

  it("removes phone separators", () => {
    expect(normalize("phone", " (555) 010-1234 ")).toBe("5550101234");
  });

  it("preserves other punctuation", () => {
    expect(normalize("name", " A-b.c ")).toBe("A-b.c");
  });
});
