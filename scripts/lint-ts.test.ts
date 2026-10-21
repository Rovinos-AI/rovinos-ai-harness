// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { eslintRunner, lintBatches, lintTs, runLintBatches, type LintBatch } from "./lint-ts.js";

const temporaryDirectories: string[] = [];

function createRoot(packages: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "lint-ts-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "packages"));
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

  expect(batches.map((batch) => batch.at(-1))).toEqual(["packages/core", "packages/store", "."]);
  expect(batches.at(-1)).toEqual(expect.arrayContaining(["--ignore-pattern", "packages/**"]));
  for (const batch of batches) {
    expect(batch.slice(0, 2)).toEqual(["--max-warnings", "0"]);
    expect(batch).toContain("--no-warn-ignored");
  }
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
