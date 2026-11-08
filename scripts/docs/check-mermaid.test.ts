// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { checkMermaid } from "./check-mermaid.js";
import type { MarkdownSource } from "./markdown.js";

describe("Mermaid checker", () => {
  it("accepts valid Mermaid diagrams", () => {
    const sources: MarkdownSource[] = [
      {
        path: "README.md",
        contents: '```mermaid\nflowchart LR\n  A["Human (label)"] --> B\n```\n',
      },
    ];

    expect(checkMermaid(sources)).toEqual([]);
  });

  it("rejects unknown diagram types and unbalanced delimiters", () => {
    const sources: MarkdownSource[] = [
      {
        path: "README.md",
        contents:
          "```mermaid\nnotADiagram LR\n  A --> B\n```\n```mermaid\nflowchart LR\n  A[broken --> B\n```\n",
      },
    ];

    expect(checkMermaid(sources)).toEqual([
      { path: "README.md", line: 1 },
      { path: "README.md", line: 5 },
    ]);
  });
});
