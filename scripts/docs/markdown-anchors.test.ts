// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { collectHeadingIds } from "./markdown-anchors.ts";

describe("Markdown anchor generation", () => {
  it("uses GitHub-style slugs and suffixes duplicate headings", () => {
    expect(collectHeadingIds("## Repeat heading\n## Repeat heading\n## `Harness CLI`\n")).toEqual(
      new Set(["repeat-heading", "repeat-heading-1", "harness-cli"]),
    );
  });
});
