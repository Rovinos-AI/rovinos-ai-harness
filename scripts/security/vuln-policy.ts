// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Normalized severity shared by dependency and image vulnerability policies. */
export const VulnerabilitySeveritySchema = z.enum([
  "critical",
  "high",
  "moderate",
  "low",
  "info",
  "unknown",
]);

/** A normalized vulnerability severity. */
export type VulnerabilitySeverity = z.infer<typeof VulnerabilitySeveritySchema>;

/** A normalized vulnerability from a supported scanner. */
export const FindingSchema = z
  .object({
    id: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    package: z.string().min(1),
    version: z.string().min(1),
    severity: VulnerabilitySeveritySchema,
    fixedIn: z.string().min(1).optional(),
  })
  .strict();

/** One expiring exception for an advisory or package. */
export const VulnerabilityExceptionSchema = z
  .object({
    id: z.string().min(1).optional(),
    package: z.string().min(1).optional(),
    reason: z.string().min(1),
    expires: z.iso.date(),
    owner: z.string().min(1),
  })
  .strict()
  .refine(
    (exception) =>
      Number(exception.id !== undefined) + Number(exception.package !== undefined) === 1,
  );

/** Shared policy contract for dependency and image vulnerability gates. */
export const VulnerabilityPolicySchema = z
  .object({
    exceptions: z.array(VulnerabilityExceptionSchema),
  })
  .strict();

/** A validated vulnerability policy. */
export type VulnerabilityPolicy = z.infer<typeof VulnerabilityPolicySchema>;

/** A validated, normalized vulnerability finding. */
export type Finding = z.infer<typeof FindingSchema>;

/** An expired policy exception. */
export type VulnerabilityException = z.infer<typeof VulnerabilityExceptionSchema>;

/** Evaluation output for findings and expired exceptions. */
export const VulnerabilityEvaluationSchema = z
  .object({
    accepted: z.array(FindingSchema),
    warnings: z.array(FindingSchema),
    failures: z.array(FindingSchema),
    expiredExceptions: z.array(VulnerabilityExceptionSchema),
  })
  .strict();

/** Report written by the dependency vulnerability gate. */
export const VulnerabilityReportSchema = z
  .object({
    findings: z.array(FindingSchema),
    accepted: z.array(FindingSchema),
    warnings: z.array(FindingSchema),
    developmentWarnings: z.array(FindingSchema),
    failures: z.array(FindingSchema),
    expiredExceptions: z.array(VulnerabilityExceptionSchema),
  })
  .strict();

const severityRank: Record<z.infer<typeof VulnerabilitySeveritySchema>, number> = {
  critical: 5,
  high: 4,
  moderate: 3,
  low: 2,
  info: 1,
  unknown: 0,
};

function isExcepted(
  finding: Finding,
  exceptions: readonly VulnerabilityException[],
  today: string,
): boolean {
  const identifiers = new Set([finding.id, ...finding.aliases]);
  return exceptions.some(
    (exception) =>
      exception.expires >= today &&
      (exception.id !== undefined
        ? identifiers.has(exception.id)
        : exception.package === finding.package),
  );
}

function findingsMatch(left: Finding, right: Finding): boolean {
  return (
    left.package === right.package &&
    left.version === right.version &&
    [left.id, ...left.aliases].some((id) => [right.id, ...right.aliases].includes(id))
  );
}

function mergePair(existing: Finding, finding: Finding): Finding {
  const id = existing.id;
  const aliases = [...new Set([existing.id, ...existing.aliases, finding.id, ...finding.aliases])]
    .filter((identifier) => identifier !== id)
    .sort();
  const severity =
    severityRank[finding.severity] > severityRank[existing.severity]
      ? finding.severity
      : existing.severity;
  const fixedIn = existing.fixedIn ?? finding.fixedIn;
  return FindingSchema.parse({
    id,
    aliases,
    package: existing.package,
    version: existing.version,
    severity,
    ...(fixedIn === undefined ? {} : { fixedIn }),
  });
}

/**
 * Evaluates normalized findings using an injected UTC clock value.
 *
 * @param findings - Validated normalized findings.
 * @param policy - Validated vulnerability policy.
 * @param now - Current time in epoch milliseconds.
 * @returns Accepted, warning, failing, and expired-exception findings.
 */
export function evaluateFindings(
  findings: readonly Finding[],
  policy: VulnerabilityPolicy,
  now: number,
): z.infer<typeof VulnerabilityEvaluationSchema> {
  const today = new Date(now).toISOString().slice(0, 10);
  const expiredExceptions = policy.exceptions.filter((exception) => exception.expires < today);
  const accepted: Finding[] = [];
  const warnings: Finding[] = [];
  const failures: Finding[] = [];

  for (const finding of findings) {
    if (isExcepted(finding, policy.exceptions, today)) {
      accepted.push(finding);
    } else if (
      finding.severity === "critical" ||
      finding.severity === "high" ||
      finding.severity === "unknown"
    ) {
      failures.push(finding);
    } else {
      warnings.push(finding);
    }
  }

  return VulnerabilityEvaluationSchema.parse({
    accepted,
    warnings,
    failures,
    expiredExceptions,
  });
}

/** Merges cross-scanner duplicates by package, version, advisory ID, or alias. */
export function mergeFindings(findings: readonly Finding[]): Finding[] {
  const merged: Finding[] = [];
  for (const finding of findings) {
    let combined = finding;
    for (let index = 0; index < merged.length;) {
      const existing = merged[index];
      if (existing !== undefined && findingsMatch(existing, combined)) {
        combined = mergePair(existing, combined);
        merged.splice(index, 1);
        index = 0;
      } else {
        index += 1;
      }
    }
    merged.push(combined);
  }
  return merged;
}
