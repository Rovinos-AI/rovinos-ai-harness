// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

const readmeMarker = "<!-- package-readme: v1 -->";
const beginMarker = "<!-- BEGIN GENERATED: readme-deps (yarn gen:readmes) -->";
const endMarker = "<!-- END GENERATED: readme-deps -->";
const skippedDirectories = new Set([".git", ".yarn", ".tmp", "coverage", "dist", "node_modules"]);
const layersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const packageManifestSchema = z.looseObject({ name: z.string().min(1) });

/** Dependency allowlist keyed by package directory name. */
export type PackageLayers = z.infer<typeof layersSchema>;

/** Creates the generated dependency diagram for a package. */
export function generateReadmeDependencyBlock(packageName: string, layers: PackageLayers): string {
  const dependencies = stringsFor(layers[packageName]);
  const importers = Object.entries(layers)
    .filter(([, allowed]) => stringsFor(allowed).includes(packageName))
    .map(([name]) => name)
    .sort();
  const lines = ["flowchart LR", `  current["${escapeLabel(packageName)}"]`];
  for (const dependency of dependencies) {
    lines.push(`  may_${nodeName(dependency)}["${escapeLabel(dependency)}"]`);
    lines.push(`  current --> may_${nodeName(dependency)}`);
  }
  for (const importer of importers) {
    lines.push(`  used_by_${nodeName(importer)}["${escapeLabel(importer)}"]`);
    lines.push(`  used_by_${nodeName(importer)} --> current`);
  }
  return [beginMarker, "```mermaid", ...lines, "```", endMarker].join("\n");
}

/** Replaces or inserts a package README's generated dependency block. */
export function replaceReadmeDependencyBlock(markdown: string, generatedBlock: string): string {
  const begins = markdown.split(beginMarker).length - 1;
  const ends = markdown.split(endMarker).length - 1;
  if (begins !== ends || begins > 1) {
    throw new Error("Invalid generated dependency markers.");
  }
  if (begins === 1) {
    return markdown.replace(
      new RegExp(`${escapeRegExp(beginMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, "u"),
      generatedBlock,
    );
  }
  const markerIndex = markdown.indexOf(readmeMarker);
  if (markerIndex < 0) {
    throw new Error("Missing package README marker.");
  }
  const insertionPoint = markerIndex + readmeMarker.length;
  return `${markdown.slice(0, insertionPoint)}\n\n${generatedBlock}${markdown.slice(insertionPoint)}`;
}

function stringsFor(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function nodeName(value: string): string {
  return value.replaceAll(/\W/gu, "_");
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function collectMarkedReadmes(rootDirectory: string): { path: string; packageName: string }[] {
  const marked: { path: string; packageName: string }[] = [];

  function collect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
        collect(join(directory, entry.name));
      }
    }
    const manifestPath = join(directory, "package.json");
    const readmePath = join(directory, "README.md");
    if (!existsSync(manifestPath) || !existsSync(readmePath)) {
      return;
    }
    parseJson(packageManifestSchema, readFileSync(manifestPath, "utf8"));
    if (readFileSync(readmePath, "utf8").includes(readmeMarker)) {
      marked.push({
        path: relative(rootDirectory, readmePath).split(sep).join("/"),
        packageName: basename(directory),
      });
    }
  }

  for (const workspaceDirectory of ["packages", "tools"]) {
    const path = join(rootDirectory, workspaceDirectory);
    if (existsSync(path)) {
      collect(path);
    }
  }
  return marked.sort((left, right) => left.path.localeCompare(right.path));
}

function runGenerator(): void {
  const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
  const layers = parseJson(
    layersSchema,
    readFileSync(join(rootDirectory, "docs/engineering/layers.json"), "utf8"),
  );
  const checkOnly = process.argv.includes("--check");
  let stale = false;
  for (const { path, packageName } of collectMarkedReadmes(rootDirectory)) {
    const absolutePath = resolve(rootDirectory, path);
    const current = readFileSync(absolutePath, "utf8");
    const expected = replaceReadmeDependencyBlock(
      current,
      generateReadmeDependencyBlock(packageName, layers),
    );
    if (current === expected) {
      continue;
    }
    if (checkOnly) {
      process.stderr.write(`Stale generated dependency block: ${path}\n`);
      stale = true;
    } else {
      writeFileSync(absolutePath, expected);
    }
  }
  if (stale) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGenerator();
}
