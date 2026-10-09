// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const packageDirectory = "packages/schemas";

it("recreates schemas output after dist and its build info are deleted", () => {
  const fixture = mkdtempSync(join(tmpdir(), "harness-schema-build-"));
  const fixturePackage = resolve(fixture, packageDirectory);
  const fixtureDist = resolve(fixturePackage, "dist");

  try {
    cpSync(resolve(root, packageDirectory, "src"), resolve(fixturePackage, "src"), {
      recursive: true,
    });
    cpSync(
      resolve(root, packageDirectory, "tsconfig.build.json"),
      resolve(fixturePackage, "tsconfig.build.json"),
    );
    cpSync(
      resolve(root, packageDirectory, "package.json"),
      resolve(fixturePackage, "package.json"),
    );
    cpSync(resolve(root, "tsconfig.base.json"), resolve(fixture, "tsconfig.base.json"));
    symlinkSync(resolve(root, "node_modules"), resolve(fixture, "node_modules"), "dir");

    const tsc = resolve(root, "node_modules/typescript/bin/tsc");
    const build = () => {
      execFileSync(process.execPath, [tsc, "-b", "tsconfig.build.json", "--pretty", "false"], {
        cwd: fixturePackage,
        stdio: "pipe",
      });
    };

    build();
    expect(existsSync(resolve(fixtureDist, "index.js"))).toBe(true);
    expect(existsSync(resolve(fixtureDist, ".tsbuildinfo"))).toBe(true);

    rmSync(fixtureDist, { recursive: true, force: true });
    build();

    expect(existsSync(resolve(fixtureDist, "index.js"))).toBe(true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 60_000);
