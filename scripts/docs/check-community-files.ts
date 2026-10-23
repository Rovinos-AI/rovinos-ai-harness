// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type CommunityFile = "CONTRIBUTING.md" | "CODE_OF_CONDUCT.md" | "SECURITY.md";

const requiredHeadings: readonly (readonly [CommunityFile, readonly string[]])[] = [
  ["CONTRIBUTING.md", ["## DCO sign-off"]],
  ["CODE_OF_CONDUCT.md", ["## Our Pledge", "## Enforcement"]],
  ["SECURITY.md", ["## Supported versions", "## Reporting"]],
];

/** Community-file validation results; messages contain paths and headings, not file contents. */
export interface CommunityFileCheck {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Checks required community policy files and reports unresolved uppercase placeholders.
 *
 * @param files - File contents keyed by repository-relative file name.
 * @param release - Whether unresolved placeholders must fail the check.
 * @returns Validation errors and non-release warnings.
 */
export function evaluateCommunityFiles(
  files: Partial<Record<CommunityFile, string>>,
  release: boolean,
): CommunityFileCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

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
    for (const placeholder of new Set(contents.match(/<[A-Z][A-Z0-9_]*>/gu) ?? [])) {
      const message = `Unresolved placeholder ${placeholder} in ${file}`;
      if (release) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  return { errors, warnings };
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

function runCheck(): void {
  const result = evaluateCommunityFiles(
    readCommunityFiles(process.cwd()),
    process.env.RELEASE === "1",
  );
  for (const warning of result.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }
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
