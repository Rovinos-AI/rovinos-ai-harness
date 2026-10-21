// SPDX-License-Identifier: Apache-2.0
// Type-aware ESLint in bounded batches. One `eslint .` process holds a TypeScript program for every
// project it touches and peaked at 5.1-5.4 GB, occasionally passing its 8 GB heap limit (#526).
// Each workspace package is linted in its own process, then the rest of the repository with
// `packages/**` ignored, so the union is exactly the file set `eslint .` lints, with the same
// config, rules and zero-warning bar. Measured on the CI agent (2026-10-20): largest batch 3.3 GB.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Arguments for one ESLint process, relative to the repository root. */
export type LintBatch = readonly string[];

/** Runs one ESLint process and returns its exit status. */
export type LintRunner = (args: readonly string[]) => number;

const sharedArguments = [
  "--max-warnings",
  "0",
  "--no-warn-ignored",
  "--no-error-on-unmatched-pattern",
];

/** Splits the repository into ESLint batches whose union equals `eslint .`. */
export function lintBatches(root: string, extraArguments: readonly string[] = []): LintBatch[] {
  const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .sort();
  return [
    ...packages.map((directory) => [...sharedArguments, ...extraArguments, directory]),
    [...sharedArguments, ...extraArguments, "--ignore-pattern", "packages/**", "."],
  ];
}

/** Runs every batch, continuing after a failure so all findings are reported, and returns 0 or 1. */
export function runLintBatches(batches: readonly LintBatch[], runner: LintRunner): number {
  let status = 0;
  for (const batch of batches) {
    if (runner(batch) !== 0) {
      status = 1;
    }
  }
  return status;
}

/** Spawns the repository's ESLint with the batch heap limit. */
export function eslintRunner(root: string): LintRunner {
  const eslint = resolve(root, "node_modules/eslint/bin/eslint.js");
  return (args) =>
    spawnSync(process.execPath, ["--max-old-space-size=8192", eslint, ...args], {
      cwd: root,
      stdio: "inherit",
    }).status ?? 1;
}

/** Lints the repository at `root` in batches and returns the process exit status. */
export function lintTs(
  root: string,
  extraArguments: readonly string[],
  runner: LintRunner = eslintRunner(root),
): number {
  return runLintBatches(lintBatches(root, extraArguments), runner);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = lintTs(
    resolve(fileURLToPath(new URL("..", import.meta.url))),
    process.argv.slice(2),
  );
}
