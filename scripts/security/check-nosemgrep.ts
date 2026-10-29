// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".yml", ".yaml"]);
const excludedDirectories = new Set([".git", "node_modules", "dist", "coverage", "reports"]);

/**
 * Returns line numbers of Semgrep suppressions that omit a rule id or written reason.
 *
 * @param source - Source text containing line comments.
 */
export function findSuppressionsWithoutReason(source: string): number[] {
  const invalidLines: number[] = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!/(?:\/\/|#)\s*nosemgrep\b/u.test(line)) {
      continue;
    }
    if (!/(?:\/\/|#)\s*nosemgrep:\s*[\w.-]+\s+--\s+\S/u.test(line)) {
      invalidLines.push(index + 1);
    }
  }
  return invalidLines;
}

function collectFiles(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        collectFiles(join(directory, entry.name), files);
      }
      continue;
    }
    if (entry.isFile()) {
      const path = join(directory, entry.name);
      const extension = path.slice(path.lastIndexOf("."));
      if (sourceExtensions.has(extension)) {
        files.push(path);
      }
    }
  }
}

/**
 * Checks source files in a repository for Semgrep suppressions without reasons.
 *
 * @param rootDirectory - Repository root to scan.
 * @returns Invalid suppression locations, relative to the repository root.
 */
export function checkNosemgrep(rootDirectory: string): string[] {
  const root = resolve(rootDirectory);
  const files: string[] = [];
  collectFiles(root, files);

  return files.flatMap((path) =>
    findSuppressionsWithoutReason(readFileSync(path, "utf8")).map(
      (line) => `${relative(root, path).split(sep).join("/")}:${String(line)}`,
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const invalid = checkNosemgrep(process.cwd());
  if (invalid.length > 0) {
    process.stderr.write(
      `Semgrep suppressions require a rule id and reason:\n${invalid.join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
