// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { evaluateCommunityFiles } from "./check-community-files.js";

const completeFiles = {
  "CONTRIBUTING.md": "# Contributing\n\n## DCO sign-off\n",
  "CODE_OF_CONDUCT.md": "# Code of Conduct\n\n## Our Pledge\n\n## Enforcement\n",
  "SECURITY.md": "# Security\n\n## Supported versions\n\n## Reporting\n",
} as const;

const noExistingPaths = new Set<string>();

describe("community policy file checker", () => {
  it("reports each missing required file", () => {
    expect(evaluateCommunityFiles({}, false, noExistingPaths).errors).toEqual([
      "Missing required community file: CONTRIBUTING.md",
      "Missing required community file: CODE_OF_CONDUCT.md",
      "Missing required community file: SECURITY.md",
    ]);
  });

  it("reports missing required headings", () => {
    const result = evaluateCommunityFiles(
      {
        ...completeFiles,
        "SECURITY.md": "# Security\n\n## Reporting\n",
      },
      false,
      noExistingPaths,
    );

    expect(result.errors).toEqual([
      'Missing required heading "## Supported versions" in SECURITY.md',
    ]);
  });

  it("warns about placeholders outside a release check", () => {
    const result = evaluateCommunityFiles(
      {
        ...completeFiles,
        "SECURITY.md": `${completeFiles["SECURITY.md"]}\nContact: <REVIEW_TARGET_2>\n`,
      },
      false,
      noExistingPaths,
    );

    expect(result).toEqual({
      errors: [],
      warnings: ["Unresolved placeholder <REVIEW_TARGET_2> in SECURITY.md"],
    });
  });

  it("rejects placeholders during a release check", () => {
    const result = evaluateCommunityFiles(
      {
        ...completeFiles,
        "SECURITY.md": `${completeFiles["SECURITY.md"]}\nContact: <REVIEW_TARGET_2>\n`,
      },
      true,
      noExistingPaths,
    );

    expect(result).toEqual({
      errors: ["Unresolved placeholder <REVIEW_TARGET_2> in SECURITY.md"],
      warnings: [],
    });
  });

  it("passes all required files with no placeholders", () => {
    expect(evaluateCommunityFiles(completeFiles, false, noExistingPaths)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it.each(["CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md"] as const)(
    "rejects missing relative links in %s",
    (file) => {
      const files = {
        ...completeFiles,
        [file]: `${completeFiles[file]}\n[missing policy](docs/missing.md#reporting)\n`,
      };

      expect(evaluateCommunityFiles(files, false, noExistingPaths).errors).toEqual([
        `Broken relative link in ${file}`,
      ]);
    },
  );

  it("accepts relative links when their target exists", () => {
    const files = {
      ...completeFiles,
      "SECURITY.md": `${completeFiles["SECURITY.md"]}\n[README](README.md#overview)\n`,
    };

    expect(evaluateCommunityFiles(files, false, new Set(["README.md"]))).toEqual({
      errors: [],
      warnings: [],
    });
  });
});
