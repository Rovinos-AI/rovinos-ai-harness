// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";
import {
  evaluateFindings,
  FindingSchema,
  mergeFindings,
  VulnerabilityPolicySchema,
  VulnerabilityReportSchema,
  type Finding,
  type VulnerabilityPolicy,
} from "./vuln-policy.ts";
import { normalizeCvss, normalizeSeverity } from "./cvss.ts";

const yarnAuditRecordSchema = z.object({
  value: z.string().optional(),
  children: z
    .object({
      ID: z.union([z.string(), z.number()]).optional(),
      Issue: z.string().optional(),
      URL: z.string().optional(),
      Severity: z.string().optional(),
      "Tree Versions": z.array(z.string().min(1)).optional(),
      "Patched Versions": z.string().optional(),
    })
    .optional(),
});

const osvVulnerabilitySchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  severity: z.array(z.object({ type: z.string(), score: z.string() })).optional(),
  database_specific: z.object({ severity: z.unknown().optional() }).optional(),
  affected: z
    .array(
      z.object({
        ranges: z
          .array(
            z.object({
              events: z.array(z.object({ fixed: z.string().optional() })),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

const osvOutputSchema = z.object({
  results: z.array(
    z.object({
      packages: z.array(
        z.object({
          package: z.object({
            name: z.string().min(1),
            version: z.string().min(1),
          }),
          vulnerabilities: z.array(osvVulnerabilitySchema).optional(),
        }),
      ),
    }),
  ),
});

type OsvVulnerability = z.infer<typeof osvVulnerabilitySchema>;
type YarnAuditAdvisory = NonNullable<z.infer<typeof yarnAuditRecordSchema>["children"]>;

const advisoryIdentifier = /\b(?:GHSA-[A-Z0-9-]+|CVE-\d{4}-\d{4,})\b/gi;

function identifiersIn(text: string): string[] {
  return [...new Set(text.match(advisoryIdentifier) ?? [])];
}

function yarnAuditIdentity(advisory: YarnAuditAdvisory): {
  id: string | undefined;
  rawId: string | undefined;
  deprecation: boolean;
} {
  const rawId = advisory.ID === undefined ? undefined : String(advisory.ID);
  if (rawId?.includes("(deprecation)") === true) {
    return { id: undefined, rawId, deprecation: true };
  }
  return {
    id: advisory.URL?.match(advisoryIdentifier)?.[0] ?? rawId,
    rawId,
    deprecation: false,
  };
}

function yarnAuditAliases(
  advisory: YarnAuditAdvisory,
  id: string,
  rawId: string | undefined,
): string[] {
  return [
    ...new Set([
      ...(rawId !== undefined && rawId !== id ? identifiersIn(rawId) : []),
      ...(advisory.Issue === undefined ? [] : identifiersIn(advisory.Issue)),
    ]),
  ].filter((alias) => alias !== id);
}

function fixedVersion(affected: OsvVulnerability["affected"]): string | undefined {
  for (const entry of affected ?? []) {
    for (const range of entry.ranges ?? []) {
      const fixed = range.events.find((event) => event.fixed !== undefined)?.fixed;
      if (fixed !== undefined) {
        return fixed;
      }
    }
  }
  return undefined;
}

function parseYarnAuditRecord(line: string): Finding[] {
  const record = parseJson(yarnAuditRecordSchema, line);
  const advisory = record.children;
  const packageName = record.value;
  if (advisory === undefined || packageName === undefined) {
    throw new Error("Yarn audit output did not match the pinned schema");
  }

  const identity = yarnAuditIdentity(advisory);
  if (identity.deprecation) {
    return [];
  }
  const id = identity.id;
  const versions = advisory["Tree Versions"] ?? [];
  if (id === undefined || versions.length === 0) {
    throw new Error("Yarn audit finding lacks an advisory ID or affected version");
  }

  const aliases = yarnAuditAliases(advisory, id, identity.rawId);
  const fixedIn = advisory["Patched Versions"]?.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
  return versions.map((version) =>
    FindingSchema.parse({
      id,
      aliases,
      package: packageName,
      version,
      severity: normalizeSeverity(advisory.Severity),
      ...(fixedIn === undefined ? {} : { fixedIn }),
    }),
  );
}

/** Parses the NDJSON output emitted by the pinned Yarn 4 audit command. */
export function parseYarnAuditOutput(output: string): Finding[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap(parseYarnAuditRecord);
}

/** Parses JSON output from OSV-Scanner v2. */
export function parseOsvScannerOutput(output: string): Finding[] {
  const report = parseJson(osvOutputSchema, output);
  const findings: Finding[] = [];
  for (const result of report.results) {
    for (const entry of result.packages) {
      for (const vulnerability of entry.vulnerabilities ?? []) {
        const databaseSeverity =
          typeof vulnerability.database_specific?.severity === "string"
            ? vulnerability.database_specific.severity
            : undefined;
        const normalizedDatabaseSeverity = normalizeSeverity(databaseSeverity);
        const severity =
          normalizedDatabaseSeverity === "unknown"
            ? (normalizeCvss(vulnerability.severity ?? []) ?? "unknown")
            : normalizedDatabaseSeverity;
        const fixedIn = fixedVersion(vulnerability.affected);
        findings.push(
          FindingSchema.parse({
            id: vulnerability.id,
            aliases: (vulnerability.aliases ?? []).filter((alias) => alias !== vulnerability.id),
            package: entry.package.name,
            version: entry.package.version,
            severity,
            ...(fixedIn === undefined ? {} : { fixedIn }),
          }),
        );
      }
    }
  }
  return findings;
}

function samePackageVersion(left: Finding, right: Finding): boolean {
  return left.package === right.package && left.version === right.version;
}

function findingsMatch(left: Finding, right: Finding): boolean {
  return (
    samePackageVersion(left, right) &&
    [left.id, ...left.aliases].some((id) => [right.id, ...right.aliases].includes(id))
  );
}

function runTool(
  command: string,
  args: readonly string[],
): { stdout: string; status: number | null } {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error("vulnerability scanner execution failed");
  }
  return { stdout: result.stdout, status: result.status };
}

function readPolicy(): VulnerabilityPolicy {
  const path = fileURLToPath(new URL("../../config/vuln-policy.json", import.meta.url));
  return parseJson(VulnerabilityPolicySchema, readFileSync(path, "utf8"));
}

/**
 * Combines scanner findings, keeping development-only Yarn findings as warnings.
 *
 * @param input - Scanner findings, policy, and injected clock value.
 * @returns A normalized report with production failures and development warnings.
 */
export function evaluateVulnerabilityReport(input: {
  productionAudit: readonly Finding[];
  allAudit: readonly Finding[];
  osvFindings: readonly Finding[];
  policy: VulnerabilityPolicy;
  now: number;
}): z.infer<typeof VulnerabilityReportSchema> {
  const { productionAudit, allAudit, osvFindings, policy, now } = input;
  const developmentAudit = allAudit.filter(
    (finding) => !productionAudit.some((production) => samePackageVersion(production, finding)),
  );
  const developmentOsv = osvFindings.filter(
    (finding) =>
      allAudit.some((audited) => findingsMatch(audited, finding)) &&
      !productionAudit.some((production) => findingsMatch(production, finding)),
  );
  const productionOsv = osvFindings.filter((finding) => !developmentOsv.includes(finding));
  const findings = mergeFindings([...productionAudit, ...allAudit, ...osvFindings]);
  const evaluation = evaluateFindings(findings, policy, now);
  const developmentIds = new Set(
    mergeFindings([...developmentAudit, ...developmentOsv]).map(
      (finding) => `${finding.package}@${finding.version}`,
    ),
  );
  const productionIds = new Set(
    mergeFindings([...productionAudit, ...productionOsv]).map(
      (finding) => `${finding.package}@${finding.version}`,
    ),
  );
  return VulnerabilityReportSchema.parse({
    findings,
    accepted: evaluation.accepted,
    warnings: evaluation.warnings.filter((finding) =>
      productionIds.has(`${finding.package}@${finding.version}`),
    ),
    developmentWarnings: findings.filter(
      (finding) =>
        developmentIds.has(`${finding.package}@${finding.version}`) &&
        !productionIds.has(`${finding.package}@${finding.version}`) &&
        !evaluation.accepted.includes(finding),
    ),
    failures: evaluation.failures.filter((finding) =>
      productionIds.has(`${finding.package}@${finding.version}`),
    ),
    expiredExceptions: evaluation.expiredExceptions,
  });
}

function evaluatePositiveControl(findings: readonly Finding[], now: number): void {
  const aliases = new Set(["CVE-2021-23337", "GHSA-35jh-r3h4-6jhm"]);
  const finding = findings.find(
    (candidate) =>
      candidate.package === "lodash" &&
      candidate.version === "4.17.20" &&
      [candidate.id, ...candidate.aliases].some((id) => aliases.has(id)),
  );
  if (finding === undefined) {
    throw new Error("vulnerability positive control was not detected");
  }
  const policy = VulnerabilityPolicySchema.parse({ exceptions: [] });
  if (evaluateFindings([finding], policy, now).failures.length === 0) {
    throw new Error("vulnerability positive control did not fail policy");
  }
}

function formatSummary(report: z.infer<typeof VulnerabilityReportSchema>): string {
  const count = (severity: string, findings: readonly Finding[]) =>
    findings.filter((finding) => finding.severity === severity).length;
  return [
    "## Dependency vulnerability scan",
    "",
    `- Findings: ${String(report.findings.length)}`,
    `- High/critical failures: ${String(report.failures.length)} (${String(count("critical", report.failures))} critical, ${String(count("high", report.failures))} high)`,
    `- Warnings: ${String(report.warnings.length)}`,
    `- Development-only warnings: ${String(report.developmentWarnings.length)}`,
    `- Accepted by policy: ${String(report.accepted.length)}`,
    `- Expired exceptions: ${String(report.expiredExceptions.length)}`,
    "",
    "See the vulnerability-report artifact for normalized advisory IDs and affected package versions.",
    "",
  ].join("\n");
}

function runScan(policy: VulnerabilityPolicy, now: number): void {
  const productionAudit = runTool("yarn", [
    "npm",
    "audit",
    "--json",
    "--all",
    "--recursive",
    "--environment=production",
  ]);
  const allAudit = runTool("yarn", ["npm", "audit", "--json", "--all", "--recursive"]);
  if (
    (productionAudit.status !== 0 && productionAudit.stdout.trim().length === 0) ||
    (allAudit.status !== 0 && allAudit.stdout.trim().length === 0)
  ) {
    throw new Error("Yarn audit failed without a valid report");
  }

  const productionFindings = parseYarnAuditOutput(productionAudit.stdout);
  const allFindings = parseYarnAuditOutput(allAudit.stdout);
  const osvResult = runTool("osv-scanner", [
    "scan",
    "--lockfile=yarn.lock",
    "--format=json",
    "--verbosity=error",
  ]);
  const osvFindings = parseOsvScannerOutput(osvResult.stdout);
  if (osvResult.status !== 0 && osvFindings.length === 0) {
    throw new Error("OSV-Scanner failed without a valid report");
  }

  const report = evaluateVulnerabilityReport({
    productionAudit: productionFindings,
    allAudit: allFindings,
    osvFindings,
    policy,
    now,
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined) {
    appendFileSync(summaryPath, formatSummary(report));
  }
  if (report.failures.length > 0 || report.expiredExceptions.length > 0) {
    process.exitCode = 1;
  }
}

function runPositiveControl(policy: VulnerabilityPolicy, now: number): void {
  const fixture = fileURLToPath(
    new URL("../../security/fixtures/vulnerable-yarn.lock", import.meta.url),
  );
  const result = runTool("osv-scanner", [
    "scan",
    `--lockfile=${fixture}`,
    "--format=json",
    "--verbosity=error",
  ]);
  const findings = parseOsvScannerOutput(result.stdout);
  if (result.status !== 0 && findings.length === 0) {
    throw new Error("OSV-Scanner positive control failed without a valid report");
  }
  evaluatePositiveControl(findings, now);
  const report = evaluateFindings(findings, policy, now);
  if (report.failures.length === 0) {
    throw new Error("configured policy unexpectedly accepted the vulnerability positive control");
  }
  process.stdout.write("Vulnerability positive control detected and blocked.\n");
}

function main(): void {
  try {
    const mode = process.argv[2];
    if (mode !== "--scan" && mode !== "--positive-control") {
      throw new Error("pass --scan or --positive-control to run this networked check");
    }
    const policy = readPolicy();
    const now = Date.now();
    if (mode === "--scan") {
      runScan(policy, now);
    } else {
      runPositiveControl(policy, now);
    }
  } catch {
    process.stderr.write("Dependency vulnerability check failed closed.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
