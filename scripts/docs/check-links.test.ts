// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { checkLinks } from "./check-links.js";
import type { MarkdownSource } from "./markdown.js";

describe("Markdown link checker", () => {
  it("reports broken relative links and anchors", () => {
    const sources: MarkdownSource[] = [
      {
        path: "README.md",
        contents: "[missing file](docs/missing.md)\n[missing anchor](docs/target.md#unknown)",
      },
      { path: "docs/target.md", contents: "## Available heading\n" },
    ];

    expect(
      checkLinks(sources, new Set(["README.md", "docs", "docs/target.md"])).map(
        ({ reason }) => reason,
      ),
    ).toEqual([
      "unresolved relative link to docs/missing.md",
      "unresolved anchor in docs/target.md",
    ]);
  });

  it("resolves GitHub anchors when headings are duplicated", () => {
    const sources: MarkdownSource[] = [
      {
        path: "README.md",
        contents:
          "[first](docs/target.md#repeat-heading) [second](docs/target.md#repeat-heading-1)",
      },
      {
        path: "docs/target.md",
        contents: "## Repeat heading\n\n## Repeat heading\n",
      },
    ];

    expect(checkLinks(sources, new Set(["README.md", "docs", "docs/target.md"]))).toEqual([]);
  });
});
