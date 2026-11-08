// SPDX-License-Identifier: Apache-2.0
// Type-aware ESLint runs in bounded batches. Each package and non-package directory is isolated;
// the SDK and cross-package tests are split by file because their TypeScript programs have the
// largest dependency graphs. Every batch uses the same config, rules and zero-warning bar.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Arguments for one ESLint process, relative to the repository root. */
export type LintBatch = readonly string[];

/** Runs one ESLint process and returns its exit status. */
export type LintRunner = (args: readonly string[]) => number;

export const MAX_ESLINT_RSS_KIB = 2_900_000;

const sharedArguments = [
  "--max-warnings",
  "0",
  "--no-warn-ignored",
  "--no-error-on-unmatched-pattern",
];

const lintableExtensions = new Set([".js", ".mjs", ".ts", ".tsx", ".mts", ".cts", ".yaml", ".yml"]);

function lintableFiles(root: string, directory: string): string[] {
  const files: string[] = [];
  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!["coverage", "dist", "node_modules"].includes(entry.name)) {
          visit(path);
        }
      } else if (entry.isFile() && lintableExtensions.has(extname(entry.name))) {
        files.push(relative(root, path));
      }
    }
  }
  visit(join(root, directory));
  return files.sort();
}

/** Splits memory-heavy projects into files and the rest into directory batches. */
export function lintBatches(root: string, extraArguments: readonly string[] = []): LintBatch[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const packageDirectories = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .sort();
  const rootDirectories = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "packages" &&
        entry.name !== ".git" &&
        entry.name !== "node_modules",
    )
    .map((entry) => entry.name)
    .sort();
  const packageBatches = packageDirectories.flatMap((directory) =>
    directory === "packages/sdk"
      ? lintableFiles(root, directory).map((file) => [...sharedArguments, ...extraArguments, file])
      : [[...sharedArguments, ...extraArguments, directory]],
  );
  const testBatches = rootDirectories.includes("test")
    ? lintableFiles(root, "test").map((file) => [...sharedArguments, ...extraArguments, file])
    : [];
  const rootIgnorePatterns = [
    "packages/**",
    ...rootDirectories.map((directory) => `${directory}/**`),
  ];
  return [
    ...packageBatches,
    ...rootDirectories
      .filter((directory) => directory !== "test")
      .map((directory) => [...sharedArguments, ...extraArguments, directory]),
    ...testBatches,
    [
      ...sharedArguments,
      ...extraArguments,
      ...rootIgnorePatterns.flatMap((pattern) => ["--ignore-pattern", pattern]),
      ".",
    ],
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

/** Parses the peak RSS reported by GNU time or macOS time. */
export function parsePeakRssKiB(stderr: string, platform: NodeJS.Platform): number | undefined {
  let match: RegExpExecArray | null;
  if (platform === "linux") {
    match = /^ESLINT_PEAK_RSS_KIB=(\d+)$/mu.exec(stderr);
  } else if (platform === "darwin") {
    match = /maximum resident set size\s*\(kbytes\):\s*([\d,]+)/iu.exec(stderr);
  } else {
    return undefined;
  }
  if (match?.[1] === undefined) {
    return undefined;
  }
  const peakRssKiB = Number(match[1].replaceAll(",", ""));
  return Number.isSafeInteger(peakRssKiB) ? peakRssKiB : undefined;
}

/** Returns whether the measured peak RSS is within the repository's lint budget. */
export function isWithinEslintMemoryBudget(peakRssKiB: number): boolean {
  return peakRssKiB <= MAX_ESLINT_RSS_KIB;
}

/** Spawns the repository's ESLint under a heap cap and per-process RSS budget. */
export function eslintRunner(root: string): LintRunner {
  const eslint = resolve(root, "node_modules/eslint/bin/eslint.js");
  return (args) => {
    const timeArguments =
      process.platform === "darwin"
        ? ["-l", process.execPath]
        : ["-f", "ESLINT_PEAK_RSS_KIB=%M", process.execPath];
    const result = spawnSync(
      "/usr/bin/time",
      [...timeArguments, "--max-old-space-size=3072", eslint, ...args],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    if (result.stdout !== "") {
      process.stdout.write(result.stdout);
    }
    const peakRssKiB = parsePeakRssKiB(result.stderr, process.platform);
    const lintStderr =
      process.platform === "linux"
        ? result.stderr.replace(/^ESLINT_PEAK_RSS_KIB=\d+\s*$/mu, "")
        : result.stderr;
    if (lintStderr !== "") {
      process.stderr.write(lintStderr);
    }
    if (peakRssKiB === undefined) {
      process.stderr.write("Unable to measure ESLint peak RSS; memory budget check failed.\n");
      return 1;
    }
    const batch = args.at(-1) ?? "<unknown>";
    process.stderr.write(
      `ESLint batch ${batch} peak RSS: ${String(Math.round(peakRssKiB / 1024))} MiB (budget ${String(
        Math.floor(MAX_ESLINT_RSS_KIB / 1024),
      )} MiB)\n`,
    );
    return isWithinEslintMemoryBudget(peakRssKiB) ? (result.status ?? 1) : 1;
  };
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
