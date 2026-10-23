// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { evaluateCommunityFiles } from "./check-community-files.js";

const completeFiles = {
  "CONTRIBUTING.md": "# Contributing\n\n## DCO sign-off\n",
  "CODE_OF_CONDUCT.md": "# Code of Conduct\n\n## Our Pledge\n\n## Enforcement\n",
  "SECURITY.md": "# Security\n\n## Supported versions\n\n## Reporting\n",
} as const;

describe("community policy file checker", () => {
  it("reports each missing required file", () => {
    expect(evaluateCommunityFiles({}, false).errors).toEqual([
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
    );

    expect(result.errors).toEqual([
      'Missing required heading "## Supported versions" in SECURITY.md',
    ]);
  });

  it("warns about placeholders outside a release check", () => {
    const result = evaluateCommunityFiles(
      {
        ...completeFiles,
        "SECURITY.md": `${completeFiles["SECURITY.md"]}\nContact: <MAINTAINER_EMAIL>\n`,
      },
      false,
    );

    expect(result).toEqual({
      errors: [],
      warnings: ["Unresolved placeholder <MAINTAINER_EMAIL> in SECURITY.md"],
    });
  });

  it("rejects placeholders during a release check", () => {
    const result = evaluateCommunityFiles(
      {
        ...completeFiles,
        "SECURITY.md": `${completeFiles["SECURITY.md"]}\nContact: <MAINTAINER_EMAIL>\n`,
      },
      true,
    );

    expect(result).toEqual({
      errors: ["Unresolved placeholder <MAINTAINER_EMAIL> in SECURITY.md"],
      warnings: [],
    });
  });

  it("passes all required files with no placeholders", () => {
    expect(evaluateCommunityFiles(completeFiles, false)).toEqual({
      errors: [],
      warnings: [],
    });
  });
});
