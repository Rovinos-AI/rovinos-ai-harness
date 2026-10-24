// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type CommunityFile = "CONTRIBUTING.md" | "CODE_OF_CONDUCT.md" | "SECURITY.md";

const requiredHeadings: readonly (readonly [CommunityFile, readonly string[]])[] = [
  ["CONTRIBUTING.md", ["## DCO sign-off"]],
  ["CODE_OF_CONDUCT.md", ["## Our Pledge", "## Enforcement"]],
  ["SECURITY.md", ["## Supported versions", "## Reporting"]],
];
const inlineMarkdownLink = /\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s[^)]*)?\)/gu;
const markdownLinkDefinition = /^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gmu;

/** Community-file validation results; messages contain paths and headings, not file contents. */
export interface CommunityFileCheck {
  readonly errors: readonly string[];
}

/**
 * Checks required community policy files and reports unresolved uppercase placeholders.
 *
 * @param files - File contents keyed by repository-relative file name.
 * @param existingPaths - Paths of relative Markdown links that resolve to repository files.
 * @returns Validation errors.
 */
export function evaluateCommunityFiles(
  files: Partial<Record<CommunityFile, string>>,
  existingPaths: ReadonlySet<string>,
): CommunityFileCheck {
  const errors: string[] = [];

  for (const [file, headings] of requiredHeadings) {
    const contents = files[file];
    if (contents === undefined) {
      errors.push(`Missing required community file: ${file}`);
      continue;
    }
    for (const heading of headings) {
      if (!contents.split(/\r?\n/u).some((line) => line.trim() === heading)) {
        errors.push(`Missing required heading "${heading}" in ${file}`);
      }
    }
    for (const placeholder of new Set(contents.match(/<[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*>/gu) ?? [])) {
      errors.push(`Unresolved placeholder ${placeholder} in ${file}`);
    }
    for (const target of markdownLinkTargets(file, contents)) {
      if (!existingPaths.has(target)) {
        errors.push(`Broken relative link in ${file}`);
      }
    }
  }

  return { errors };
}

function markdownLinkTargets(file: CommunityFile, contents: string): string[] {
  const destinations = [
    ...contents.matchAll(inlineMarkdownLink),
    ...contents.matchAll(markdownLinkDefinition),
  ].flatMap((match) => {
    const destination = match[1]?.replaceAll(/^<|>$/gu, "");
    if (
      destination === undefined ||
      destination.startsWith("/") ||
      destination.startsWith("#") ||
      destination.startsWith("//") ||
      /^[A-Za-z][A-Za-z\d+.-]*:/u.test(destination)
    ) {
      return [];
    }
    const path = destination.split(/[?#]/u, 1)[0] ?? "";
    if (path.length === 0) {
      return [];
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(path);
    } catch {
      return [posix.normalize(posix.join(posix.dirname(file), path))];
    }
    return [posix.normalize(posix.join(posix.dirname(file), decodedPath))];
  });

  return [...new Set(destinations)];
}

function readCommunityFiles(rootDirectory: string): Partial<Record<CommunityFile, string>> {
  const files: Partial<Record<CommunityFile, string>> = {};
  for (const [file] of requiredHeadings) {
    const path = join(rootDirectory, file);
    if (existsSync(path)) {
      files[file] = readFileSync(path, "utf8");
    }
  }
  return files;
}

function existingLinkedPaths(
  rootDirectory: string,
  files: Partial<Record<CommunityFile, string>>,
): Set<string> {
  const existingPaths = new Set<string>();
  for (const [file] of requiredHeadings) {
    const contents = files[file];
    if (contents === undefined) {
      continue;
    }
    for (const target of markdownLinkTargets(file, contents)) {
      const absolutePath = resolve(rootDirectory, target);
      const relativePath = relative(rootDirectory, absolutePath);
      if (
        relativePath.length > 0 &&
        !relativePath.startsWith(`..${sep}`) &&
        relativePath !== ".." &&
        !isAbsolute(relativePath) &&
        existsSync(absolutePath)
      ) {
        existingPaths.add(target);
      }
    }
  }
  return existingPaths;
}

function runCheck(): void {
  const rootDirectory = process.cwd();
  const files = readCommunityFiles(rootDirectory);
  const result = evaluateCommunityFiles(files, existingLinkedPaths(rootDirectory, files));
  for (const error of result.errors) {
    process.stderr.write(`Error: ${error}\n`);
  }
  if (result.errors.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCheck();
}
