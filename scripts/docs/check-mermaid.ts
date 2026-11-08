// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectMarkdownSources, extractFencedBlocks, type MarkdownSource } from "./markdown.ts";

const diagramTypes = new Set([
  "architecture-beta",
  "block-beta",
  "C4Context",
  "classDiagram",
  "erDiagram",
  "flowchart",
  "gantt",
  "gitGraph",
  "graph",
  "info",
  "journey",
  "kanban",
  "mindmap",
  "packet-beta",
  "pie",
  "quadrantChart",
  "radar-beta",
  "requirementDiagram",
  "sankey-beta",
  "sequenceDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "timeline",
  "treemap",
  "xychart-beta",
]);

/** One structurally invalid Mermaid diagram. */
export interface MermaidIssue {
  readonly path: string;
  readonly line: number;
}

/**
 * Checks fenced Mermaid blocks for a recognized diagram type and balanced delimiters.
 *
 * @param sources - Markdown sources to inspect.
 * @returns Invalid diagrams in source order.
 */
export function checkMermaid(sources: readonly MarkdownSource[]): MermaidIssue[] {
  const issues: MermaidIssue[] = [];
  for (const source of sources) {
    for (const block of extractFencedBlocks(source.contents)) {
      if (block.language === "mermaid" && !isStructurallyValid(block.contents)) {
        issues.push({ path: source.path, line: block.startLine });
      }
    }
  }
  return issues;
}

function isStructurallyValid(contents: string): boolean {
  const withoutQuotedText = contents.replaceAll(/"(?:\\.|[^"\\])*"/gu, "");
  if (withoutQuotedText.includes('"')) {
    return false;
  }
  const firstLine = withoutQuotedText
    .split("\n")
    .map((line) => line.replaceAll(/%%.*$/gu, "").trim())
    .find((line) => line.length > 0);
  const keyword = firstLine === undefined ? undefined : /^([A-Za-z][\w-]*)\b/u.exec(firstLine)?.[1];
  return (
    keyword !== undefined && diagramTypes.has(keyword) && hasBalancedDelimiters(withoutQuotedText)
  );
}

function hasBalancedDelimiters(contents: string): boolean {
  const stack: string[] = [];
  for (const line of contents.split("\n")) {
    for (const character of line.replaceAll(/%%.*$/gu, "")) {
      if (character === "(" || character === "[" || character === "{") {
        stack.push(character);
      } else if (character === ")" || character === "]" || character === "}") {
        const opening = stack.pop();
        if (
          (character === ")" && opening !== "(") ||
          (character === "]" && opening !== "[") ||
          (character === "}" && opening !== "{")
        ) {
          return false;
        }
      }
    }
  }
  return stack.length === 0;
}

function runCheck(): void {
  const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
  const issues = checkMermaid(collectMarkdownSources(rootDirectory));
  for (const issue of issues) {
    process.stderr.write(
      `Error: structurally invalid Mermaid diagram at ${issue.path}:${String(issue.line)}\n`,
    );
  }
  if (issues.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCheck();
}
