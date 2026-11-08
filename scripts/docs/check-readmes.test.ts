// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { checkReadmes } from "./check-readmes.js";
import { generateReadmeDependencyBlock } from "./gen-readme-deps.js";
import type { MarkdownSource } from "./markdown.js";

const layers = { pkg: ["schemas"], schemas: [] };
const generatedBlock = generateReadmeDependencyBlock("pkg", layers);
const headings = [
  "Purpose",
  "Where it fits",
  "How it works",
  "Public API",
  "Inputs and outputs",
  "Configuration, telemetry and errors",
  "Security and privacy",
  "Testing",
  "Related docs",
];
const diagrams = [
  "```mermaid\nflowchart LR\n  A --> B\n```",
  "```mermaid\nsequenceDiagram\n  A->>B: call\n```",
];

function source(contents: string): MarkdownSource {
  return { path: "packages/pkg/README.md", contents };
}

function validReadme(): string {
  return [
    "<!-- package-readme: v1 -->",
    generatedBlock,
    ...headings.map((heading) => `## ${heading}\n\nPackage documentation.`),
    ...diagrams,
  ].join("\n\n");
}

function reasons(contents: string, workspacePaths = ["packages/pkg"]): string[] {
  return checkReadmes([source(contents)], layers, workspacePaths).map(({ reason }) => reason);
}

describe("package README checker", () => {
  it("accepts a README that follows the template", () => {
    expect(reasons(validReadme())).toEqual([]);
  });

  it("ignores unmarked READMEs until require-all is enabled", () => {
    expect(
      checkReadmes([{ path: "packages/pkg/README.md", contents: "# Legacy README\n" }], layers, [
        "packages/pkg",
      ]),
    ).toEqual([]);
  });

  it("rejects a missing section", () => {
    const markdown = validReadme().replace("## Testing\n\nPackage documentation.\n\n", "");
    expect(reasons(markdown).join(" ")).toContain("missing required sections");
  });

  it("rejects sections in the wrong order", () => {
    const markdown = validReadme().replace(
      "## Purpose\n\nPackage documentation.\n\n## Where it fits",
      "## Where it fits\n\nPackage documentation.\n\n## Purpose",
    );
    expect(reasons(markdown)).toContain("required sections are out of order");
  });

  it("requires two hand-written Mermaid diagrams in addition to the generated one", () => {
    const markdown = validReadme().replace(`\n\n${diagrams[1] ?? ""}`, "");
    expect(reasons(markdown).join(" ")).toContain("requires at least two hand-written");
  });

  it("rejects a stale generated dependency block", () => {
    const markdown = validReadme().replace('may_schemas["schemas"]', 'may_other["other"]');
    expect(reasons(markdown)).toContain("generated dependency block is missing or stale");
  });

  it("supports require-all for workspace packages without marked READMEs", () => {
    const issues = checkReadmes(
      [source(validReadme())],
      layers,
      ["packages/pkg", "tools/missing-readme"],
      true,
    );
    expect(issues).toContainEqual({
      path: "tools/missing-readme/README.md",
      reason: "workspace package is missing a marked README",
    });
  });
});
