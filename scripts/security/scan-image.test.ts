// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateImageFindings,
  evaluateImagePositiveControl,
  imageScanErrorCode,
  ImageScanError,
  parseTrivyReport,
  requireOsPackageInventory,
} from "./scan-image.ts";
import { FindingSchema, VulnerabilityPolicySchema } from "./vuln-policy.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const now = Date.parse("2026-10-29T00:00:00.000Z");
const emptyPolicy = VulnerabilityPolicySchema.parse({ exceptions: [] });
const highFinding = FindingSchema.parse({
  id: "CVE-2021-23337",
  aliases: [],
  package: "lodash",
  version: "4.17.20",
  severity: "high",
  fixedIn: "4.17.21",
});

describe("parseTrivyReport", () => {
  it("normalizes fixed vulnerabilities and leaves unfixable findings without a fixed version", () => {
    const report = `{
      "SchemaVersion": 2,
      "Results": [
        {
          "Target": "image",
          "Vulnerabilities": [
            {
              "VulnerabilityID": "CVE-2021-23337",
              "Aliases": ["GHSA-35jh-r3h4-6jhm", "CVE-2021-23337"],
              "PkgName": "lodash",
              "InstalledVersion": "4.17.20",
              "FixedVersion": "4.17.21",
              "Severity": "HIGH"
            },
            {
              "VulnerabilityID": "CVE-2026-1000",
              "PkgName": "other-package",
              "InstalledVersion": "1.0.0",
              "FixedVersion": "",
              "Severity": "CRITICAL"
            }
          ]
        }
      ]
    }`;

    expect(parseTrivyReport(report)).toEqual([
      {
        ...highFinding,
        aliases: ["GHSA-35jh-r3h4-6jhm"],
      },
      {
        id: "CVE-2026-1000",
        aliases: [],
        package: "other-package",
        version: "1.0.0",
        severity: "critical",
      },
    ]);
  });

  it("accepts an empty scan result", () => {
    expect(parseTrivyReport('{"Results":[]}')).toEqual([]);
    expect(parseTrivyReport('{"Results":null}')).toEqual([]);
  });

  it("fails closed when the scanner omits its results field", () => {
    expect(() => parseTrivyReport("{}")).toThrow(
      expect.objectContaining({ code: "scanner_report_invalid" }),
    );
  });

  it("fails closed on malformed scanner JSON", () => {
    expect(() => parseTrivyReport("{")).toThrow(
      expect.objectContaining({ code: "scanner_report_invalid" }),
    );
    expect(() => parseTrivyReport("")).toThrow(
      expect.objectContaining({ code: "scanner_report_invalid" }),
    );
    expect(() => parseTrivyReport('{"Results":[{"Vulnerabilities":[{}]}]}')).toThrow(
      expect.objectContaining({ code: "scanner_report_invalid" }),
    );
  });

  it("fails closed when the OS package inventory is empty", () => {
    expect(() => {
      requireOsPackageInventory(
        JSON.stringify({
          Results: [{ Class: "os-pkgs", Packages: [], Vulnerabilities: [] }],
        }),
      );
    }).toThrow(expect.objectContaining({ code: "image_os_packages_missing" }));
  });

  it("accepts a populated OS package inventory without requiring vulnerabilities", () => {
    expect(() => {
      requireOsPackageInventory(
        JSON.stringify({
          Results: [{ Class: "os-pkgs", Packages: [{ Name: "libc6" }], Vulnerabilities: [] }],
        }),
      );
    }).not.toThrow();
  });
});

describe("evaluateImageFindings", () => {
  it.each([
    { severity: "critical", failures: 1, warnings: 0 },
    { severity: "high", failures: 1, warnings: 0 },
    { severity: "moderate", failures: 0, warnings: 1 },
    { severity: "low", failures: 0, warnings: 1 },
  ] as const)(
    "applies the shared threshold to fixable $severity findings",
    ({ severity, failures, warnings }) => {
      const finding = FindingSchema.parse({ ...highFinding, severity });
      const result = evaluateImageFindings([finding], emptyPolicy, now);

      expect(result.failures).toHaveLength(failures);
      expect(result.warnings).toHaveLength(warnings);
    },
  );

  it("does not block an unfixable high-severity finding", () => {
    const finding = FindingSchema.parse({ ...highFinding, fixedIn: undefined });
    const result = evaluateImageFindings([finding], emptyPolicy, now);

    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("accepts an unexpired matching exception and reports expired exceptions", () => {
    const policy = VulnerabilityPolicySchema.parse({
      exceptions: [
        {
          id: "CVE-2021-23337",
          reason: "Temporary exception for a controlled image migration.",
          expires: "2026-11-29",
          owner: "security-maintainers",
        },
        {
          package: "old-package",
          reason: "Expired exception regression fixture.",
          expires: "2026-10-28",
          owner: "security-maintainers",
        },
      ],
    });
    const result = evaluateImageFindings([highFinding], policy, now);

    expect(result.accepted).toEqual([highFinding]);
    expect(result.failures).toEqual([]);
    expect(result.expiredExceptions).toHaveLength(1);
  });
});

describe("image vulnerability positive control", () => {
  it("blocks the recorded vulnerable Trivy report", () => {
    const fixture = readFileSync(
      resolve(root, "scripts/security/__fixtures__/trivy-vulnerability-report.json"),
      "utf8",
    );

    expect(() => {
      evaluateImagePositiveControl(parseTrivyReport(fixture), now);
    }).not.toThrow();
  });

  it("fails with a closed code when the seeded vulnerability is absent", () => {
    expect(() => {
      evaluateImagePositiveControl([], now);
    }).toThrow(expect.objectContaining({ code: "positive_control_undetected" }));
  });

  it("does not expose unexpected diagnostic text", () => {
    expect(imageScanErrorCode(new Error("sensitive scanner output"))).toBe("image_scan_failed");
    expect(imageScanErrorCode(new ImageScanError("scanner_report_invalid"))).toBe(
      "scanner_report_invalid",
    );
  });
});
