// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

const rendererSources = import.meta.glob("./src/**/*.{ts,tsx}", {
  eager: true,
  import: "default",
  query: "?raw",
});

const copyPatterns = [
  /\b(?:textContent|innerText)\s*=\s*["'`][^"'`]+["'`]/u,
  /setAttribute\(\s*["']aria-label["']\s*,\s*["'`][^"'`]+["'`]/u,
  /(?:createElement|element)\(\s*(?:document|this\.document)\s*,\s*["'][a-z][\w-]*["']\s*,\s*["'`](?![^"'`]*\$\{)[^"'`]+["'`]/u,
];

function hasLiteralCopy(source: string): boolean {
  return copyPatterns.some((pattern) => pattern.test(source));
}

describe("view string catalog lint", () => {
  it("requires user-visible copy in views to come from the shared kit", () => {
    const sources = Object.entries(rendererSources)
      .filter(
        ([path]) =>
          !path.endsWith(".test.ts") &&
          !path.endsWith(".test.tsx") &&
          path !== "./src/kit/strings.ts",
      )
      .map(([, source]) => source)
      .filter((source): source is string => typeof source === "string");
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(hasLiteralCopy(source)).toBe(false);
    }
  });

  it("detects a literal in an imported renderer source", () => {
    const importedRenderer = `
      export function renderStatus(status: HTMLElement): void {
        status.textContent = "Hardcoded renderer copy";
      }
    `;
    expect(hasLiteralCopy(importedRenderer)).toBe(true);
  });
});
