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

function vectorMetrics(
  parts: readonly string[],
  required: readonly string[],
  optional: readonly string[],
): Map<string, string> | undefined {
  const allowed = new Set([...required, ...optional]);
  const metrics = new Map<string, string>();
  for (const part of parts) {
    const [name, value] = part.split(":");
    if (name === undefined || value === undefined || !allowed.has(name) || metrics.has(name)) {
      return undefined;
    }
    metrics.set(name, value);
  }
  return required.every((name) => metrics.has(name)) ? metrics : undefined;
}

function metricValue(
  metrics: ReadonlyMap<string, string>,
  name: string,
  values: Record<string, number>,
): number | undefined {
  const value = metrics.get(name);
  return value === undefined ? undefined : values[value];
}

function cvssV3Score(vector: string): number | undefined {
  const [version, ...parts] = vector.split("/");
  if (version !== "CVSS:3.0" && version !== "CVSS:3.1") {
    return undefined;
  }
  const metrics = vectorMetrics(
    parts,
    ["AV", "AC", "PR", "UI", "S", "C", "I", "A"],
    ["E", "RL", "RC"],
  );
  if (metrics === undefined) {
    return undefined;
  }

  const scope = metrics.get("S");
  const attackVector = metricValue(metrics, "AV", { N: 0.85, A: 0.62, L: 0.55, P: 0.2 });
  const attackComplexity = metricValue(metrics, "AC", { L: 0.77, H: 0.44 });
  const privilegesRequired = metricValue(
    metrics,
    "PR",
    scope === "C" ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 },
  );
  const userInteraction = metricValue(metrics, "UI", { N: 0.85, R: 0.62 });
  const confidentiality = metricValue(metrics, "C", { N: 0, L: 0.22, H: 0.56 });
  const integrity = metricValue(metrics, "I", { N: 0, L: 0.22, H: 0.56 });
  const availability = metricValue(metrics, "A", { N: 0, L: 0.22, H: 0.56 });
  if (
    scope === undefined ||
    (scope !== "U" && scope !== "C") ||
    attackVector === undefined ||
    attackComplexity === undefined ||
    privilegesRequired === undefined ||
    userInteraction === undefined ||
    confidentiality === undefined ||
    integrity === undefined ||
    availability === undefined
  ) {
    return undefined;
  }

  const impactSubScore = 1 - (1 - confidentiality) * (1 - integrity) * (1 - availability);
  const impact =
    scope === "U"
      ? 6.42 * impactSubScore
      : 7.52 * (impactSubScore - 0.029) - 3.25 * (impactSubScore - 0.02) ** 15;
  if (impact <= 0) {
    return 0;
  }
  const exploitability =
    8.22 * attackVector * attackComplexity * privilegesRequired * userInteraction;
  const score =
    scope === "U"
      ? Math.min(impact + exploitability, 10)
      : Math.min(1.08 * (impact + exploitability), 10);
  return Math.ceil(score * 10 - 1e-10) / 10;
}

function cvssV2Score(vector: string): number | undefined {
  const metrics = vectorMetrics(
    vector.split("/"),
    ["AV", "AC", "Au", "C", "I", "A"],
    ["E", "RL", "RC"],
  );
  if (metrics === undefined) {
    return undefined;
  }
  const attackVector = metricValue(metrics, "AV", { N: 1, A: 0.646, L: 0.395 });
  const attackComplexity = metricValue(metrics, "AC", { L: 0.71, M: 0.61, H: 0.35 });
  const authentication = metricValue(metrics, "Au", { N: 0.704, S: 0.56, M: 0.45 });
  const confidentiality = metricValue(metrics, "C", { N: 0, P: 0.275, C: 0.66 });
  const integrity = metricValue(metrics, "I", { N: 0, P: 0.275, C: 0.66 });
  const availability = metricValue(metrics, "A", { N: 0, P: 0.275, C: 0.66 });
  if (
    attackVector === undefined ||
    attackComplexity === undefined ||
    authentication === undefined ||
    confidentiality === undefined ||
    integrity === undefined ||
    availability === undefined
  ) {
    return undefined;
  }
  const impact = 10.41 * (1 - (1 - confidentiality) * (1 - integrity) * (1 - availability));
  if (impact === 0) {
    return 0;
  }
  const exploitability = 20 * attackVector * attackComplexity * authentication;
  return Math.round((0.6 * impact + 0.4 * exploitability - 1.5) * 1.176 * 10) / 10;
}

function severityFromCvss(type: string, vector: string): string | undefined {
  if (type === "Ubuntu") {
    return normalizeSeverity(vector);
  }
  const score =
    type === "CVSS_V3" ? cvssV3Score(vector) : type === "CVSS_V2" ? cvssV2Score(vector) : undefined;
  if (score === undefined) {
    return undefined;
  }
  if (type === "CVSS_V2") {
    return score >= 7 ? "high" : score >= 4 ? "moderate" : score > 0 ? "low" : "info";
  }
  return score >= 9
    ? "critical"
    : score >= 7
      ? "high"
      : score >= 4
        ? "moderate"
        : score > 0
          ? "low"
          : "info";
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

function normalizeCvss(
  scores: NonNullable<OsvVulnerability["severity"]>,
): z.infer<typeof VulnerabilitySeveritySchema> | undefined {
  const rank: Record<z.infer<typeof VulnerabilitySeveritySchema>, number> = {
    critical: 5,
    high: 4,
    moderate: 3,
    low: 2,
    info: 1,
    unknown: 0,
  };
  let highest: z.infer<typeof VulnerabilitySeveritySchema> | undefined;
  for (const { type, score } of scores) {
    const severity = VulnerabilitySeveritySchema.safeParse(severityFromCvss(type, score));
    if (severity.success && (highest === undefined || rank[severity.data] > rank[highest])) {
      highest = severity.data;
    }
  }
  return highest;
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
