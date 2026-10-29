// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  evaluateFindings,
  FindingSchema,
  mergeFindings,
  VulnerabilityPolicySchema,
} from "./vuln-policy.ts";
import {
  evaluatePositiveControl,
  evaluateVulnerabilityReport,
  parseOsvScannerOutput,
  parseYarnAuditOutput,
  positiveControlArgs,
  vulnerabilityCheckErrorCode,
} from "./check-vulns.ts";

const now = Date.parse("2026-10-29T00:00:00.000Z");
const emptyPolicy = VulnerabilityPolicySchema.parse({ exceptions: [] });
const highFinding = FindingSchema.parse({
  id: "GHSA-35jh-r3h4-6jhm",
  aliases: ["CVE-2021-23337"],
  package: "lodash",
  version: "4.17.20",
  severity: "high",
  fixedIn: "4.17.21",
});

describe("evaluateFindings", () => {
  it.each([
    { severity: "critical", failures: 1, warnings: 0 },
    { severity: "high", failures: 1, warnings: 0 },
    { severity: "moderate", failures: 0, warnings: 1 },
    { severity: "low", failures: 0, warnings: 1 },
    { severity: "info", failures: 0, warnings: 1 },
    { severity: "unknown", failures: 1, warnings: 0 },
  ] as const)("applies the threshold to $severity findings", ({ severity, failures, warnings }) => {
    const finding = FindingSchema.parse({ ...highFinding, severity });
    const result = evaluateFindings([finding], emptyPolicy, now);

    expect(result.failures).toHaveLength(failures);
    expect(result.warnings).toHaveLength(warnings);
  });

  it("accepts a matching unexpired exception by advisory alias", () => {
    const policy = VulnerabilityPolicySchema.parse({
      exceptions: [
        {
          id: "CVE-2021-23337",
          reason: "Temporary exception for a controlled migration.",
          expires: "2026-11-29",
          owner: "security-maintainers",
        },
      ],
    });

    expect(evaluateFindings([highFinding], policy, now).accepted).toEqual([highFinding]);
  });

  it("rejects an exception for a different package", () => {
    const policy = VulnerabilityPolicySchema.parse({
      exceptions: [
        {
          package: "other-package",
          reason: "Temporary exception for a controlled migration.",
          expires: "2026-11-29",
          owner: "security-maintainers",
        },
      ],
    });

    expect(evaluateFindings([highFinding], policy, now).failures).toEqual([highFinding]);
  });

  it("fails for an expired exception even without a matching finding", () => {
    const policy = VulnerabilityPolicySchema.parse({
      exceptions: [
        {
          package: "lodash",
          reason: "Temporary exception for a controlled migration.",
          expires: "2026-10-28",
          owner: "security-maintainers",
        },
      ],
    });

    expect(evaluateFindings([], policy, now).expiredExceptions).toHaveLength(1);
  });

  it("fails a finding after its matching exception expires", () => {
    const policy = VulnerabilityPolicySchema.parse({
      exceptions: [
        {
          id: "GHSA-35jh-r3h4-6jhm",
          reason: "Temporary exception for a controlled migration.",
          expires: "2026-10-28",
          owner: "security-maintainers",
        },
      ],
    });

    const result = evaluateFindings([highFinding], policy, now);
    expect(result.failures).toEqual([highFinding]);
    expect(result.expiredExceptions).toHaveLength(1);
  });

  it("does not accept an exception that expires today", () => {
    const policy = VulnerabilityPolicySchema.parse({
      exceptions: [
        {
          package: "lodash",
          reason: "Temporary exception for a controlled migration.",
          expires: "2026-10-29",
          owner: "security-maintainers",
        },
      ],
    });

    expect(evaluateFindings([highFinding], policy, now).accepted).toEqual([highFinding]);
  });
});

describe("evaluateVulnerabilityReport", () => {
  it("reports known development-only high findings as warnings", () => {
    const report = evaluateVulnerabilityReport({
      productionAudit: [],
      allAudit: [highFinding],
      osvFindings: [highFinding],
      policy: emptyPolicy,
      now,
    });

    expect(report.failures).toEqual([]);
    expect(report.developmentWarnings).toEqual([highFinding]);
  });

  it("fails closed for high OSV findings without a known development-only scope", () => {
    const report = evaluateVulnerabilityReport({
      productionAudit: [],
      allAudit: [],
      osvFindings: [highFinding],
      policy: emptyPolicy,
      now,
    });

    expect(report.failures).toEqual([highFinding]);
  });

  it("keeps a production high finding blocking when both scanners report it", () => {
    const report = evaluateVulnerabilityReport({
      productionAudit: [highFinding],
      allAudit: [highFinding],
      osvFindings: [highFinding],
      policy: emptyPolicy,
      now,
    });

    expect(report.failures).toEqual([highFinding]);
    expect(report.developmentWarnings).toEqual([]);
  });
});

describe("scanner output parsing", () => {
  it("normalizes the pinned Yarn 4 NDJSON audit report and skips deprecation notices", () => {
    const output = [
      '{"value":"@azure/msal-node","children":{"ID":1243111,"Issue":"MSAL Node authorization code flow may disclose parameters to an attacker-controlled endpoint","URL":"https://github.com/advisories/GHSA-xcx6-jx8p-x3h5","Severity":"high","Vulnerable Versions":">=5.0.0-beta.0 <7.1.0","Tree Versions":["6.0.1"],"Dependents":["@azure/identity@npm:4.14.0"]}}',
      '{"value":"node-domexception","children":{"ID":"node-domexception (deprecation)","Issue":"Use your platform\'s native DOMException instead","Severity":"moderate","Tree Versions":["1.0.0"]}}',
    ].join("\n");

    expect(parseYarnAuditOutput(output)).toEqual([
      {
        id: "GHSA-xcx6-jx8p-x3h5",
        aliases: [],
        package: "@azure/msal-node",
        version: "6.0.1",
        severity: "high",
      },
    ]);
  });

  it("normalizes recorded OSV-Scanner JSON and derives fixed versions and CVSS severity", () => {
    const output = `{
      "results": [
        {
          "source": { "path": "yarn.lock", "type": "lockfile" },
          "packages": [
            {
              "package": { "name": "lodash", "version": "4.17.20", "ecosystem": "npm" },
              "vulnerabilities": [
                {
                  "id": "GHSA-35jh-r3h4-6jhm",
                  "aliases": ["CVE-2021-23337"],
                  "severity": [{ "type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N" }],
                  "database_specific": { "severity": "HIGH", "cwe_ids": ["CWE-94"] },
                  "affected": [
                    {
                      "ranges": [{ "events": [{ "introduced": "0" }, { "fixed": "4.17.21" }] }]
                    }
                  ]
                }
              ],
              "groups": [{ "ids": ["GHSA-35jh-r3h4-6jhm"] }]
            }
          ]
        }
      ]
    }`;

    expect(parseOsvScannerOutput(output)).toEqual([highFinding]);
  });

  it("derives CVSS v3 critical severity from the OSV vector", () => {
    const output =
      '{"results":[{"packages":[{"package":{"name":"lodash","version":"4.17.20"},"vulnerabilities":[{"id":"GHSA-critical-1234-5678","severity":[{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}]}]}]}]}';

    expect(parseOsvScannerOutput(output)[0]?.severity).toBe("critical");
  });

  it("maps the maximum CVSS v2 score to high, not critical", () => {
    const output =
      '{"results":[{"packages":[{"package":{"name":"lodash","version":"4.17.20"},"vulnerabilities":[{"id":"GHSA-high-1234-5678","severity":[{"type":"CVSS_V2","score":"AV:N/AC:L/Au:N/C:C/I:C/A:C"}]}]}]}]}';

    expect(parseOsvScannerOutput(output)[0]?.severity).toBe("high");
  });

  it("merges cross-scanner duplicates connected by advisory aliases", () => {
    const yarn = parseYarnAuditOutput(
      '{"value":"lodash","children":{"ID":124,"URL":"https://github.com/advisories/GHSA-35jh-r3h4-6jhm","Severity":"moderate","Tree Versions":["4.17.20"]}}',
    );

    expect(mergeFindings([...yarn, highFinding])).toEqual([highFinding]);
  });

  it("merges transitive advisory aliases without losing the strongest severity", () => {
    const first = FindingSchema.parse({
      ...highFinding,
      id: "GHSA-35jh-r3h4-6jhm",
      aliases: ["CVE-2021-23337"],
      severity: "low",
    });
    const second = FindingSchema.parse({
      ...highFinding,
      id: "GHSA-other-1234-5678",
      aliases: ["CVE-2021-23337"],
      severity: "moderate",
    });
    const bridge = FindingSchema.parse({
      ...highFinding,
      id: "CVE-2021-23337",
      aliases: ["GHSA-35jh-r3h4-6jhm", "GHSA-other-1234-5678"],
      severity: "critical",
    });

    expect(mergeFindings([first, second, bridge])).toHaveLength(1);
    expect(mergeFindings([first, second, bridge])[0]?.severity).toBe("critical");
  });

  it("fails closed on malformed scanner JSON", () => {
    expect(() => parseOsvScannerOutput("{")).toThrow(
      expect.objectContaining({ code: "osv_report_invalid" }),
    );
  });

  it("reports invalid Yarn audit output with a closed code", () => {
    expect(() => parseYarnAuditOutput("{")).toThrow(
      expect.objectContaining({ code: "audit_report_invalid" }),
    );
  });

  it("reports an undetected positive-control advisory with a closed code", () => {
    expect(() => {
      evaluatePositiveControl([], now);
    }).toThrow(expect.objectContaining({ code: "positive_control_undetected" }));
  });

  it("uses the safe fallback code without exposing unexpected error text", () => {
    expect(vulnerabilityCheckErrorCode(new Error("sensitive diagnostic text"))).toBe(
      "vulnerability_check_failed",
    );
  });

  it("selects the Yarn lockfile parser explicitly for the vulnerable fixture", () => {
    expect(positiveControlArgs("security/fixtures/vulnerable-yarn.lock")).toContain(
      "--lockfile=yarn.lock:security/fixtures/vulnerable-yarn.lock",
    );
  });
});
