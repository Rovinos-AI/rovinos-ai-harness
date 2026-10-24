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
    expect(evaluateCommunityFiles({}, noExistingPaths).errors).toEqual([
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
      noExistingPaths,
    );

    expect(result.errors).toEqual([
      'Missing required heading "## Supported versions" in SECURITY.md',
    ]);
  });

  it("rejects unfilled placeholders", () => {
    const result = evaluateCommunityFiles(
      {
        ...completeFiles,
        "SECURITY.md": `${completeFiles["SECURITY.md"]}\nContact: <REVIEW_TARGET_2>\n`,
      },
      noExistingPaths,
    );

    expect(result.errors).toEqual(["Unresolved placeholder <REVIEW_TARGET_2> in SECURITY.md"]);
  });

  it("passes all required files with no placeholders", () => {
    expect(evaluateCommunityFiles(completeFiles, noExistingPaths)).toEqual({ errors: [] });
  });

  it.each(["CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md"] as const)(
    "rejects missing relative links in %s",
    (file) => {
      const files = {
        ...completeFiles,
        [file]: `${completeFiles[file]}\n[missing policy](docs/missing.md#reporting)\n`,
      };

      expect(evaluateCommunityFiles(files, noExistingPaths).errors).toEqual([
        `Broken relative link in ${file}`,
      ]);
    },
  );

  it("accepts relative links when their target exists", () => {
    const files = {
      ...completeFiles,
      "SECURITY.md": `${completeFiles["SECURITY.md"]}\n[README](README.md#overview)\n`,
    };

    expect(evaluateCommunityFiles(files, new Set(["README.md"]))).toEqual({ errors: [] });
  });
});
