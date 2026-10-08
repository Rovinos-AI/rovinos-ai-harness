// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateLicenses,
  LicensePolicySchema,
  readInstalledPackages,
  type LicensePackage,
} from "./check-licenses.js";

const temporaryDirectories: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "check-licenses-"));
  temporaryDirectories.push(root);
  return root;
}

function writePackage(root: string, packagePath: string, manifest: Record<string, unknown>): void {
  const directory = join(root, "node_modules", packagePath);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const policy = LicensePolicySchema.parse({
  allow: ["MIT", "Apache-2.0", "BSD-3-Clause"],
  deny: ["GPL-*", "AGPL-*", "LGPL-*", "SSPL-*", "BUSL-*", "CC-BY-NC*"],
  exceptions: [],
});

describe("evaluateLicenses", () => {
  it.each([
    { license: "MIT", allowed: true },
    { license: "MIT OR GPL-3.0", allowed: true },
    { license: "GPL-3.0", allowed: false },
    { license: "MIT AND GPL-3.0", allowed: false },
    { license: "UNLICENSED", allowed: false },
    { license: "Not-A-Real-License", allowed: false },
  ])("evaluates $license as allowed=$allowed", ({ license, allowed }) => {
    const dependency: LicensePackage = {
      name: "example-package",
      version: "1.2.3",
      license,
    };

    expect(evaluateLicenses([dependency], policy, "2026-10-08")).toEqual(
      allowed ? [] : [{ package: "example-package", version: "1.2.3", license }],
    );
  });

  it("honors a matching, unexpired exception", () => {
    const exceptionPolicy = LicensePolicySchema.parse({
      ...policy,
      exceptions: [
        {
          package: "example-package",
          version: "1.2.3",
          reason: "Approved for a temporary migration.",
          expires: "2026-10-09",
        },
      ],
    });

    expect(
      evaluateLicenses(
        [{ name: "example-package", version: "1.2.3", license: "GPL-3.0" }],
        exceptionPolicy,
        "2026-10-08",
      ),
    ).toEqual([]);
  });

  it("fails an expired exception even if its package is not installed", () => {
    const exceptionPolicy = LicensePolicySchema.parse({
      ...policy,
      exceptions: [
        {
          package: "example-package",
          reason: "Temporary approval.",
          expires: "2026-10-07",
        },
      ],
    });

    expect(evaluateLicenses([], exceptionPolicy, "2026-10-08")).toEqual([
      {
        package: "example-package",
        version: "*",
        license: "expired exception (2026-10-07)",
      },
    ]);
  });

  it("does not let denied identifiers pass through the allowlist", () => {
    const conflictingPolicy = LicensePolicySchema.parse({
      ...policy,
      allow: ["MIT", "GPL-3.0"],
    });

    expect(
      evaluateLicenses(
        [{ name: "example-package", version: "1.2.3", license: "GPL-3.0" }],
        conflictingPolicy,
        "2026-10-08",
      ),
    ).toHaveLength(1);
  });
});

describe("readInstalledPackages", () => {
  it("reads top-level, scoped, and nested packages and normalizes license fields", async () => {
    const root = createRoot();
    writePackage(root, "top-level", {
      name: "top-level",
      version: "1.0.0",
      license: "MIT",
    });
    writePackage(root, "@scope/scoped", {
      name: "@scope/scoped",
      version: "2.0.0",
      license: { type: "Apache-2.0", url: "https://example.invalid/license" },
    });
    writePackage(root, "parent/node_modules/nested", {
      name: "nested",
      version: "3.0.0",
      licenses: [{ type: "MIT" }, { type: "BSD-3-Clause" }],
    });
    writePackage(root, "missing-license", {
      name: "missing-license",
      version: "4.0.0",
    });

    const packages = await readInstalledPackages(root);

    expect(packages).toEqual(
      expect.arrayContaining([
        { name: "top-level", version: "1.0.0", license: "MIT" },
        { name: "@scope/scoped", version: "2.0.0", license: "Apache-2.0" },
        { name: "nested", version: "3.0.0", license: "MIT OR BSD-3-Clause" },
        { name: "missing-license", version: "4.0.0", license: "UNLICENSED" },
      ]),
    );
    expect(packages).toHaveLength(4);
  });

  it("reports a rejected installed GPL package and exits nonzero in the CLI", () => {
    const root = createRoot();
    writePackage(root, "gpl-probe", {
      name: "gpl-probe",
      version: "9.8.7",
      license: "GPL-3.0-only",
    });
    const script = fileURLToPath(new URL("./check-licenses.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gpl-probe");
    expect(result.stderr).toContain("9.8.7");
    expect(result.stderr).toContain("GPL-3.0-only");
  });
});
