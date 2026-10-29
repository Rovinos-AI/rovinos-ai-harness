// SPDX-License-Identifier: Apache-2.0
import { VulnerabilitySeveritySchema, type VulnerabilitySeverity } from "./vuln-policy.ts";

type CvssV3BaseMetrics = {
  scope: "U" | "C";
  attackVector: number;
  attackComplexity: number;
  privilegesRequired: number;
  userInteraction: number;
  confidentiality: number;
  integrity: number;
  availability: number;
};

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

function cvssV3BaseMetrics(vector: string): CvssV3BaseMetrics | undefined {
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
  if (scope !== "U" && scope !== "C") {
    return undefined;
  }
  if (
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
  return {
    scope,
    attackVector,
    attackComplexity,
    privilegesRequired,
    userInteraction,
    confidentiality,
    integrity,
    availability,
  };
}

function cvssV3Score(vector: string): number | undefined {
  const metrics = cvssV3BaseMetrics(vector);
  if (metrics === undefined) {
    return undefined;
  }
  const impactSubScore =
    1 -
    (1 - metrics.confidentiality) *
      (1 - metrics.integrity) *
      (1 - metrics.availability);
  let impact =
    metrics.scope === "U"
      ? 6.42 * impactSubScore
      : 7.52 * (impactSubScore - 0.029) - 3.25 * (impactSubScore - 0.02) ** 15;
  if (impact <= 0) {
    return 0;
  }
  const exploitability =
    8.22 *
    metrics.attackVector *
    metrics.attackComplexity *
    metrics.privilegesRequired *
    metrics.userInteraction;
  const score =
    metrics.scope === "U"
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
  const impact =
    10.41 * (1 - (1 - confidentiality) * (1 - integrity) * (1 - availability));
  if (impact === 0) {
    return 0;
  }
  const exploitability = 20 * attackVector * attackComplexity * authentication;
  return Math.round((0.6 * impact + 0.4 * exploitability - 1.5) * 1.176 * 10) / 10;
}

function severityFromCvss(type: string, vector: string): VulnerabilitySeverity | undefined {
  if (type === "Ubuntu") {
    return normalizeSeverity(vector);
  }

  let score: number | undefined;
  if (type === "CVSS_V3") {
    score = cvssV3Score(vector);
  } else if (type === "CVSS_V2") {
    score = cvssV2Score(vector);
  }
  if (score === undefined) {
    return undefined;
  }
  if (type === "CVSS_V2") {
    if (score >= 7) {
      return "high";
    }
    if (score >= 4) {
      return "moderate";
    }
    return score > 0 ? "low" : "info";
  }
  if (score >= 9) {
    return "critical";
  }
  if (score >= 7) {
    return "high";
  }
  if (score >= 4) {
    return "moderate";
  }
  return score > 0 ? "low" : "info";
}

/** Normalizes scanner severity labels to the shared policy values. */
export function normalizeSeverity(severity: string | undefined): VulnerabilitySeverity {
  const normalized = severity?.toLowerCase();
  if (normalized === "medium") {
    return "moderate";
  }
  if (normalized === "negligible") {
    return "info";
  }
  const parsed = VulnerabilitySeveritySchema.safeParse(normalized);
  return parsed.success ? parsed.data : "unknown";
}

/** Converts OSV severity metadata into the shared high/critical policy scale. */
export function normalizeCvss(
  scores: readonly { readonly type: string; readonly score: string }[],
): VulnerabilitySeverity | undefined {
  const rank: Record<VulnerabilitySeverity, number> = {
    critical: 5,
    high: 4,
    moderate: 3,
    low: 2,
    info: 1,
    unknown: 0,
  };
  let highest: VulnerabilitySeverity | undefined;
  for (const { type, score } of scores) {
    const severity = severityFromCvss(type, score);
    if (severity !== undefined && (highest === undefined || rank[severity] > rank[highest])) {
      highest = severity;
    }
  }
  return highest;
}
