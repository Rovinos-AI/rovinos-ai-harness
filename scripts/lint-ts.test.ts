// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  eslintRunner,
  isWithinEslintMemoryBudget,
  lintBatches,
  lintTs,
  MAX_ESLINT_RSS_KIB,
  parsePeakRssKiB,
  runLintBatches,
  type LintBatch,
} from "./lint-ts.ts";

const temporaryDirectories: string[] = [];

function createRoot(packages: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "lint-ts-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "packages"));
  mkdirSync(join(root, "scripts"));
  for (const name of packages) {
    mkdirSync(join(root, "packages", name));
  }
  writeFileSync(join(root, "packages", "README.md"), "# not a package\n");
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("lints each package in its own batch and the rest of the repository with packages ignored", () => {
  const batches = lintBatches(createRoot(["store", "core"]));

  expect(batches.map((batch) => batch.at(-1))).toEqual([
    "packages/core",
    "packages/store",
    "scripts",
    ".",
  ]);
  expect(batches.at(-1)).toEqual(
    expect.arrayContaining(["--ignore-pattern", "packages/**", "--ignore-pattern", "scripts/**"]),
  );
  for (const batch of batches) {
    expect(batch.slice(0, 2)).toEqual(["--max-warnings", "0"]);
    expect(batch).toContain("--no-warn-ignored");
  }
});

it("splits the SDK, examples, and cross-package tests into individual lintable files", () => {
  const root = createRoot(["sdk"]);
  mkdirSync(join(root, "packages", "sdk", "src"));
  mkdirSync(join(root, "examples", "retrieval"), { recursive: true });
  mkdirSync(join(root, "test", "fixtures"), { recursive: true });
  writeFileSync(join(root, "packages", "sdk", "src", "index.ts"), "export {};\n");
  writeFileSync(join(root, "examples", "retrieval", "run.ts"), "export {};\n");
  writeFileSync(join(root, "test", "fixtures", "sample.ts"), "export {};\n");
  writeFileSync(join(root, "test", "fixtures", "ignored.json"), "{}\n");

  const batches = lintBatches(root);
  const targets = batches.map((batch) => batch.at(-1));

  expect(targets).toEqual([
    "packages/sdk/src/index.ts",
    "scripts",
    "examples/retrieval/run.ts",
    "test/fixtures/sample.ts",
    ".",
  ]);
  expect(batches.at(-1)).toEqual(
    expect.arrayContaining(["--ignore-pattern", "examples/**", "--ignore-pattern", "test/**"]),
  );
});

it("passes extra arguments such as --fix to every batch", () => {
  const batches = lintBatches(createRoot(["core"]), ["--fix"]);

  expect(batches.every((batch) => batch.includes("--fix"))).toBe(true);
});

it("runs every batch and fails when any batch fails", () => {
  const seen: LintBatch[] = [];
  const batches: LintBatch[] = [["packages/a"], ["packages/b"], ["."]];

  expect(
    runLintBatches(batches, (args) => {
      seen.push(args);
      return args.includes("packages/b") ? 1 : 0;
    }),
  ).toBe(1);
  expect(seen).toEqual(batches);
  expect(runLintBatches(batches, () => 0)).toBe(0);
});

it("parses Linux and macOS peak RSS measurements and enforces the memory budget", () => {
  expect(parsePeakRssKiB("ESLINT_PEAK_RSS_KIB=123456\n", "linux")).toBe(123456);
  expect(parsePeakRssKiB("maximum resident set size (kbytes): 2,900,001\n", "darwin")).toBe(
    2_900_001,
  );
  expect(parsePeakRssKiB("missing measurement\n", "linux")).toBeUndefined();
  expect(isWithinEslintMemoryBudget(MAX_ESLINT_RSS_KIB)).toBe(true);
  expect(isWithinEslintMemoryBudget(MAX_ESLINT_RSS_KIB + 1)).toBe(false);
});

function withFakeEslint(root: string, source: string): void {
  mkdirSync(join(root, "node_modules", "eslint", "bin"), { recursive: true });
  writeFileSync(join(root, "node_modules", "eslint", "bin", "eslint.js"), source);
}

it("spawns the repository's ESLint for each batch and reports its exit status", () => {
  const root = createRoot(["core"]);
  withFakeEslint(root, 'process.exitCode = process.argv.includes("packages/core") ? 3 : 0;\n');

  expect(eslintRunner(root)(["packages/core"])).toBe(3);
  expect(eslintRunner(root)(["."])).toBe(0);
  expect(lintTs(root, [])).toBe(1);
});

it("passes when every batch passes", () => {
  const root = createRoot(["core", "store"]);
  withFakeEslint(root, "process.exitCode = 0;\n");

  expect(lintTs(root, ["--fix"])).toBe(0);
});
