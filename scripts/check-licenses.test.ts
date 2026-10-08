// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { evaluateLicenses, LicensePolicySchema, type LicensePackage } from "./check-licenses.js";

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
