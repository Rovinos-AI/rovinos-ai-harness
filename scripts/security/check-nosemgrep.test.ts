// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkNosemgrep, findSuppressionsWithoutReason } from "./check-nosemgrep.js";

const temporaryDirectories: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "check-nosemgrep-"));
  temporaryDirectories.push(root);
  return root;
}

function suppression(prefix: string, suffix: string): string {
  return `${prefix} nosem` + `grep${suffix}`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("findSuppressionsWithoutReason", () => {
  it("accepts a rule id with a non-empty reason", () => {
    expect(
      findSuppressionsWithoutReason(suppression("//", ": harness.rule -- compatibility")),
    ).toEqual([]);
  });

  it.each([
    ["//", ""],
    ["//", ": harness.rule"],
    ["//", ": harness.rule --"],
    ["#", ": harness.rule --   "],
  ])("rejects a suppression without a written reason", (prefix, suffix) => {
    expect(findSuppressionsWithoutReason(suppression(prefix, suffix))).toEqual([1]);
  });

  it("reports all invalid lines while ignoring ordinary comments", () => {
    const source = [
      suppression("//", ": harness.ok -- compatibility exception"),
      suppression("#", ": harness.missing"),
      "// ordinary comment",
      "const text = 'nosemgrep';",
    ].join("\n");

    expect(findSuppressionsWithoutReason(source)).toEqual([2]);
  });
});

describe("checkNosemgrep", () => {
  it("checks source files and returns repository-relative locations", () => {
    const root = createRoot();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "unsafe.ts"), suppression("//", ": harness.rule"));
    writeFileSync(join(root, "README.md"), suppression("//", ": harness.rule"));

    expect(checkNosemgrep(root)).toEqual(["src/unsafe.ts:1"]);
  });

  it("ignores dependency and build directories", () => {
    const root = createRoot();
    for (const directory of ["node_modules", "dist", "coverage", "reports", ".git"]) {
      const nested = join(root, directory);
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "ignored.ts"), suppression("//", ": harness.rule"));
    }

    expect(checkNosemgrep(root)).toEqual([]);
  });
});
