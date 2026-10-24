// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectMarkdownSources, findClaimViolations } from "./lint-claims.js";

const bannedPhrases = [
  "completely secure",
  "100% safe",
  "impossible to leak",
  "guaranteed compliant",
  "never leaks",
  "cannot leak",
] as const;

describe("documentation claims linter", () => {
  it.each(bannedPhrases)("detects the banned phrase %s without regard to case", (phrase) => {
    expect(
      findClaimViolations([{ path: "README.md", contents: `This is ${phrase.toUpperCase()}.` }]),
    ).toEqual([{ path: "README.md", line: 1, phrase }]);
  });

  it("honors an inline allow marker only on its own line", () => {
    expect(
      findClaimViolations([
        {
          path: "docs/example.md",
          contents: "This cannot leak. <!-- claims:allow -->\nThis cannot leak.",
        },
      ]),
    ).toEqual([{ path: "docs/example.md", line: 2, phrase: "cannot leak" }]);
  });

  it("scans the README and nested Markdown files in docs", () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "claims-lint-"));
    try {
      mkdirSync(join(rootDirectory, "docs", "nested"), { recursive: true });
      writeFileSync(join(rootDirectory, "README.md"), "A README.");
      writeFileSync(join(rootDirectory, "docs", "nested", "page.md"), "A documentation page.");
      writeFileSync(join(rootDirectory, "docs", "ignored.txt"), "not Markdown");

      expect(collectMarkdownSources(rootDirectory).map(({ path }) => path)).toEqual([
        "docs/nested/page.md",
        "README.md",
      ]);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("links each structural guarantee to existing test files and CI jobs", () => {
    const rootDirectory = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const documentPath = join(rootDirectory, "docs", "guarantees.md");
    const markdown = readFileSync(documentPath, "utf8");
    const evidenceEntries = [
      ...markdown.matchAll(/- \*\*Evidence:\*\*([\s\S]*?)(?=\n- \*\*Assumptions:\*\*)/gu),
    ];
    expect(evidenceEntries).toHaveLength(5);

    for (const [entry] of evidenceEntries) {
      const links = [...entry.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)];
      expect(links.length).toBeGreaterThan(0);
      for (const [, target] of links) {
        expect(target).toMatch(/\.test\.ts$/u);
        expect(readFileSync(resolve(rootDirectory, "docs", target ?? ""), "utf8")).toBeTruthy();
      }

      const jobs = [...entry.matchAll(/`(static|unit|integration|gates)`/gu)].map(([, job]) => job);
      expect(jobs.length).toBeGreaterThan(0);
    }
  });
});
