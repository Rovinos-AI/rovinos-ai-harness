// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

const viewSources = import.meta.glob("./src/views/**/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
});

describe("view string catalog lint", () => {
  it("requires user-visible copy in views to come from the shared kit", () => {
    const sources = Object.values(viewSources);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).not.toMatch(/\b(?:textContent|innerText)\s*=\s*["'`]/u);
      expect(source).not.toMatch(/setAttribute\(\s*["']aria-label["']\s*,\s*["'`]/u);
      expect(source).not.toMatch(/(?:createElement|element)\([^)]*,\s*["'`][A-Z][^"'`]{2,}["'`]/u);
    }
  });
});
