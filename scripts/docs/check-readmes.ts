// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";
import {
  generateReadmeDependencyBlock,
  replaceReadmeDependencyBlock,
  type PackageLayers,
} from "./gen-readme-deps.ts";
import {
  collectMarkdownSources,
  extractFencedBlocks,
  type MarkdownSource,
} from "./markdown.ts";

const readmeMarker = "<!-- package-readme: v1 -->";
const beginMarker = "<!-- BEGIN GENERATED: readme-deps (yarn gen:readmes) -->";
const endMarker = "<!-- END GENERATED: readme-deps -->";
const requiredSections = [
  "Purpose",
  "Where it fits",
  "How it works",
  "Public API",
  "Inputs and outputs",
  "Configuration, telemetry and errors",
  "Security and privacy",
  "Testing",
  "Related docs",
] as const;
const layersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const skippedDirectories = new Set([".git", ".yarn", ".tmp", "coverage", "dist", "node_modules"]);

/** One package README validation issue. */
export interface ReadmeIssue {
  readonly path: string;
  readonly reason: string;
}

/**
 * Validates marked package README structure, diagrams, and generated dependency blocks.
 *
 * @param sources - Markdown sources to inspect.
 * @param layers - Canonical package dependency allowlist.
 * @param workspacePaths - Workspace directories containing package manifests.
 * @param requireAll - Whether every workspace must have a marked README.
 * @returns Validation issues.
 */
export function checkReadmes(
  sources: readonly MarkdownSource[],
  layers: PackageLayers,
  workspacePaths: readonly string[],
  requireAll = false,
): ReadmeIssue[] {
  const issues: ReadmeIssue[] = [];
  const marked = new Set<string>();

  for (const source of sources) {
    if (!source.contents.includes(readmeMarker)) {
      continue;
    }
    if (!/^(?:packages|tools)\/.+\/README\.md$/u.test(source.path)) {
      continue;
    }
    marked.add(source.path);
    const packageName = source.path.split("/").at(-2) ?? "";
    const headings = source.contents
      .split(/\r?\n/u)
      .flatMap((line) => {
        const match = /^##\s+(.+?)\s*#*\s*$/u.exec(line);
        return match === null ? [] : [match[1] ?? ""];
      })
      .filter((heading) => requiredSections.some((required) => heading === required));
    if (headings.length !== requiredSections.length) {
      const missing = requiredSections.filter((required) => !headings.includes(required));
      issues.push({
        path: source.path,
        reason: `missing required sections: ${missing.join(", ") || "duplicate section"}`,
      });
    } else if (headings.some((heading, index) => heading !== requiredSections[index])) {
      issues.push({ path: source.path, reason: "required sections are out of order" });
    }

    const generatedStart = source.contents.indexOf(beginMarker);
    const generatedEnd = source.contents.indexOf(endMarker);
    const diagrams = extractFencedBlocks(source.contents).filter(
      (block) =>
        block.language === "mermaid" &&
        !(generatedStart >= 0 && generatedEnd > generatedStart &&
          block.start > generatedStart && block.end <= generatedEnd),
    );
    if (diagrams.length < 2) {
      issues.push({
        path: source.path,
        reason: `requires at least two hand-written Mermaid diagrams; found ${diagrams.length}`,
      });
    }

    let matchesGeneratedBlock = false;
    try {
      matchesGeneratedBlock =
        source.contents ===
        replaceReadmeDependencyBlock(
          source.contents,
          generateReadmeDependencyBlock(packageName, layers),
        );
    } catch {
      matchesGeneratedBlock = false;
    }
    if (!matchesGeneratedBlock) {
      issues.push({ path: source.path, reason: "generated dependency block is missing or stale" });
    }
  }

  if (requireAll) {
    for (const workspacePath of workspacePaths) {
      const path = `${workspacePath}/README.md`;
      if (!marked.has(path)) {
        issues.push({ path, reason: "workspace package is missing a marked README" });
      }
    }
  }

  return issues;
}

function collectWorkspacePaths(rootDirectory: string): string[] {
  const paths: string[] = [];
  function collect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
        collect(join(directory, entry.name));
      }
    }
    if (existsSync(join(directory, "package.json"))) {
      paths.push(relative(rootDirectory, directory).split(sep).join("/"));
    }
  }
  for (const name of ["packages", "tools"]) {
    const directory = join(rootDirectory, name);
    if (existsSync(directory)) {
      collect(directory);
    }
  }
  return paths.sort();
}

function runCheck(): void {
  const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
  const layers = parseJson(
    layersSchema,
    readFileSync(join(rootDirectory, "docs/engineering/layers.json"), "utf8"),
  );
  const issues = checkReadmes(
    collectMarkdownSources(rootDirectory),
    layers,
    collectWorkspacePaths(rootDirectory),
    process.argv.includes("--require-all"),
  );
  for (const issue of issues) {
    process.stderr.write(`Error: ${issue.reason} in ${issue.path}\n`);
  }
  if (issues.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCheck();
}
