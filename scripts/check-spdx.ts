// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const codeExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const hashExtensions = new Set([".sh", ".yml", ".yaml"]);
const excludedDirectories = new Set([".git", "node_modules", "dist", "coverage", "__golden__"]);

function collectFiles(directory: string, root: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        collectFiles(join(directory, entry.name), root, files);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const path = join(directory, entry.name);
    const relativePath = relative(root, path).split(sep).join("/");
    const extension = relativePath.slice(relativePath.lastIndexOf("."));
    if (
      relativePath !== "yarn.lock" &&
      (codeExtensions.has(extension) || hashExtensions.has(extension))
    ) {
      files.push(path);
    }
  }
}

function expectedHeader(path: string): string {
  const extension = path.slice(path.lastIndexOf("."));
  return hashExtensions.has(extension)
    ? "# SPDX-License-Identifier: Apache-2.0"
    : "// SPDX-License-Identifier: Apache-2.0";
}

function hasHeader(contents: string, header: string): boolean {
  const lines = contents.split(/\r?\n/);
  return lines[0] === header || (lines[0]?.startsWith("#!") === true && lines[1] === header);
}

function addHeader(contents: string, header: string): string {
  const firstLineEnd = contents.indexOf("\n");
  const firstLine =
    firstLineEnd === -1 ? contents : contents.slice(0, firstLineEnd).replace(/\r$/, "");
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  let insertionPoint = 0;
  if (firstLine.startsWith("#!")) {
    insertionPoint = firstLineEnd === -1 ? contents.length : firstLineEnd + 1;
  }

  return `${contents.slice(0, insertionPoint)}${header}${newline}${contents.slice(insertionPoint)}`;
}

/**
 * Finds source files missing their required SPDX header and optionally repairs them.
 *
 * @param rootDirectory - Directory tree to scan.
 * @param fix - Whether to prepend missing headers.
 * @returns Relative paths of files still missing headers.
 */
export function checkSpdx(rootDirectory: string, fix = false): string[] {
  const root = resolve(rootDirectory);
  const files: string[] = [];
  collectFiles(root, root, files);

  const missing: string[] = [];
  for (const path of files) {
    const header = expectedHeader(path);
    const contents = readFileSync(path, "utf8");
    if (hasHeader(contents, header)) {
      continue;
    }
    if (fix) {
      writeFileSync(path, addHeader(contents, header));
    } else {
      missing.push(relative(root, path).split(sep).join("/"));
    }
  }
  return missing;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--fix")) {
    process.stderr.write("Usage: yarn check:spdx [--fix]\n");
    process.exitCode = 2;
  } else {
    const missing = checkSpdx(process.cwd(), args.includes("--fix"));
    if (missing.length > 0) {
      process.stderr.write(`Missing SPDX headers:\n${missing.join("\n")}\n`);
      process.exitCode = 1;
    }
  }
}
