// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { generateReadmeDependencyBlock, replaceReadmeDependencyBlock } from "./gen-readme-deps.js";

describe("package README dependency generator", () => {
  it("renders allowed imports and packages that import the package", () => {
    const block = generateReadmeDependencyBlock("schemas", {
      schemas: [],
      core: ["schemas", "telemetry"],
      cli: ["core"],
    });

    expect(block).toBe(
      [
        "<!-- BEGIN GENERATED: readme-deps (yarn gen:readmes) -->",
        "```mermaid",
        "flowchart LR",
        '  current["schemas"]',
        '  used_by_core["core"]',
        "  used_by_core --> current",
        "```",
        "<!-- END GENERATED: readme-deps -->",
      ].join("\n"),
    );
  });

  it("inserts the generated dependency block after the package marker", () => {
    expect(
      replaceReadmeDependencyBlock("<!-- package-readme: v1 -->\n\n# Example\n", "generated"),
    ).toBe("<!-- package-readme: v1 -->\n\ngenerated\n\n# Example\n");
  });

  it("replaces an existing generated block without changing surrounding text", () => {
    expect(
      replaceReadmeDependencyBlock(
        "<!-- package-readme: v1 -->\nold\n<!-- BEGIN GENERATED: readme-deps (yarn gen:readmes) -->\nstale\n<!-- END GENERATED: readme-deps -->\nend",
        "<!-- BEGIN GENERATED: readme-deps (yarn gen:readmes) -->\ncurrent\n<!-- END GENERATED: readme-deps -->",
      ),
    ).toContain("\ncurrent\n");
  });
});
