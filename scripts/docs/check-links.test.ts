// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { checkLinks, collectMarkdownLinks } from "./check-links.ts";
import type { MarkdownSource } from "./markdown.ts";

describe("Markdown link checker", () => {
  it("does not extend bare URLs across Markdown link brackets or punctuation", () => {
    const markdown = [
      "[https://example.test/faq](https://example.test/faq)",
      "[https://example.test/reference][reference]",
      "",
      "[reference]: https://example.test/reference",
      "",
      "https://example.test/parenthesis) https://example.test/bracket]",
    ].join("\n");
    const destinations = collectMarkdownLinks(markdown).map(({ destination }) => destination);

    expect([...new Set(destinations)].sort()).toEqual(
      [
        "https://example.test/bracket",
        "https://example.test/faq",
        "https://example.test/parenthesis",
        "https://example.test/reference",
      ].sort(),
    );
  });

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

  it("reports missing relative image files", () => {
    const sources: MarkdownSource[] = [
      { path: "docs/approval-app.md", contents: "![Pending approval](images/missing.png)" },
    ];

    expect(checkLinks(sources, new Set(["docs", "docs/approval-app.md", "docs/images"]))).toEqual([
      {
        path: "docs/approval-app.md",
        line: 1,
        reason: "unresolved relative link to docs/images/missing.png",
      },
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
