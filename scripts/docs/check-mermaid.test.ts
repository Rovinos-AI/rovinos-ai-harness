// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { checkMermaid } from "./check-mermaid.js";
import type { MarkdownSource } from "./markdown.js";

describe("Mermaid checker", () => {
  it("accepts valid Mermaid diagrams", async () => {
    const sources: MarkdownSource[] = [
      {
        path: "README.md",
        contents: '```mermaid\nflowchart LR\n  A["Human label"] --> B\n```\n',
      },
    ];

    expect(await checkMermaid(sources)).toEqual([]);
  });

  it("rejects invalid Mermaid diagrams", async () => {
    const sources: MarkdownSource[] = [
      { path: "README.md", contents: "```mermaid\nflowchart LR\n  A -->\n```\n" },
    ];

    expect(await checkMermaid(sources)).toEqual([{ path: "README.md", line: 1 }]);
  });
});
