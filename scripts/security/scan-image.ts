// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";
import { normalizeSeverity } from "./cvss.ts";
import {
  evaluateFindings,
  FindingSchema,
  mergeFindings,
  VulnerabilityPolicySchema,
  type Finding,
  type VulnerabilityPolicy,
} from "./vuln-policy.ts";

const trivyVulnerabilitySchema = z.object({
  VulnerabilityID: z.string().min(1),
  Aliases: z.array(z.string().min(1)).optional(),
  PkgName: z.string().min(1),
  InstalledVersion: z.string().min(1),
  FixedVersion: z.string().optional().nullable(),
  Severity: z.string().optional(),
});

const trivyReportSchema = z.object({
  Results: z
    .array(
      z.object({
        Vulnerabilities: z.array(trivyVulnerabilitySchema).nullable().optional(),
      }),
    )
    .nullable(),
});

const imageScanReportSchema = z
  .object({
    image: z.string().min(1),
    findings: z.array(FindingSchema),
    accepted: z.array(FindingSchema),
    warnings: z.array(FindingSchema),
    failures: z.array(FindingSchema),
    expiredExceptions: VulnerabilityPolicySchema.shape.exceptions,
  })
  .strict();

const imageScanErrorCodeSchema = z.enum([
  "scanner_report_invalid",
  "positive_control_undetected",
  "image_scan_failed",
]);
const maxTrivyReportBytes = 16 * 1024 * 1024;

type ImageScanErrorCode = z.infer<typeof imageScanErrorCodeSchema>;

/** A closed, safe-to-log failure code for the image vulnerability check. */
export class ImageScanError extends Error {
  readonly code: ImageScanErrorCode;

  constructor(code: ImageScanErrorCode) {
    super(code);
    this.name = "ImageScanError";
    this.code = imageScanErrorCodeSchema.parse(code);
  }
}

type ImageScanReport = z.infer<typeof imageScanReportSchema>;

/** Returns a safe, closed failure code without exposing unexpected error text. */
export function imageScanErrorCode(error: unknown): ImageScanErrorCode {
  return error instanceof ImageScanError ? error.code : "image_scan_failed";
}

/** Parses Trivy JSON into the shared normalized finding contract. */
export function parseTrivyReport(output: string): Finding[] {
  try {
    const report = parseJson(trivyReportSchema, output, { maxBytes: maxTrivyReportBytes });
    return (report.Results ?? []).flatMap((result) =>
      (result.Vulnerabilities ?? []).map((vulnerability) => {
        const fixedIn = vulnerability.FixedVersion?.trim();
        return FindingSchema.parse({
          id: vulnerability.VulnerabilityID,
          aliases: (vulnerability.Aliases ?? []).filter(
            (alias) => alias !== vulnerability.VulnerabilityID,
          ),
          package: vulnerability.PkgName,
          version: vulnerability.InstalledVersion,
          severity: normalizeSeverity(vulnerability.Severity),
          ...(fixedIn === undefined || fixedIn.length === 0 ? {} : { fixedIn }),
        });
      }),
    );
  } catch {
    throw new ImageScanError("scanner_report_invalid");
  }
}

/** Applies the shared vulnerability evaluator to fixable image findings. */
export function evaluateImageFindings(
  findings: readonly Finding[],
  policy: VulnerabilityPolicy,
  now: number,
): ReturnType<typeof evaluateFindings> {
  return evaluateFindings(
    mergeFindings(findings.filter((finding) => finding.fixedIn !== undefined)),
    policy,
    now,
  );
}

/** Requires the recorded vulnerable image report to produce a blocking finding. */
export function evaluateImagePositiveControl(findings: readonly Finding[], now: number): void {
  const finding = findings.find(
    (candidate) =>
      candidate.package === "lodash" &&
      candidate.version === "4.17.20" &&
      [candidate.id, ...candidate.aliases].includes("CVE-2021-23337"),
  );
  if (
    finding === undefined ||
    evaluateImageFindings([finding], { exceptions: [] }, now).failures.length === 0
  ) {
    throw new ImageScanError("positive_control_undetected");
  }
}

function readPolicy(): VulnerabilityPolicy {
  try {
    const path = fileURLToPath(new URL("../../config/image-vuln-policy.json", import.meta.url));
    return parseJson(VulnerabilityPolicySchema, readFileSync(path, "utf8"));
  } catch {
    throw new ImageScanError("image_scan_failed");
  }
}

function makeReport(
  image: string,
  findings: readonly Finding[],
  policy: VulnerabilityPolicy,
  now: number,
): ImageScanReport {
  const evaluation = evaluateImageFindings(findings, policy, now);
  return imageScanReportSchema.parse({
    image,
    findings,
    accepted: evaluation.accepted,
    warnings: evaluation.warnings,
    failures: evaluation.failures,
    expiredExceptions: evaluation.expiredExceptions,
  });
}

function runPositiveControl(): void {
  try {
    const fixture = fileURLToPath(
      new URL("./__fixtures__/trivy-vulnerability-report.json", import.meta.url),
    );
    evaluateImagePositiveControl(parseTrivyReport(readFileSync(fixture, "utf8")), Date.now());
  } catch (error) {
    if (error instanceof ImageScanError) {
      throw error;
    }
    throw new ImageScanError("image_scan_failed");
  }
  process.stdout.write("Image vulnerability positive control detected and blocked.\n");
}

function runReport(reportPath: string, image: string): void {
  try {
    const findings = parseTrivyReport(readFileSync(reportPath, "utf8"));
    const report = makeReport(image, findings, readPolicy(), Date.now());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath !== undefined) {
      appendFileSync(
        summaryPath,
        [
          "## Image vulnerability scan",
          "",
          `- Image: ${image}`,
          `- Findings: ${String(report.findings.length)}`,
          `- Fixable HIGH/CRITICAL failures: ${String(report.failures.length)}`,
          `- Accepted by policy: ${String(report.accepted.length)}`,
          `- Expired exceptions: ${String(report.expiredExceptions.length)}`,
          "",
        ].join("\n"),
      );
    }
    if (report.failures.length > 0 || report.expiredExceptions.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof ImageScanError) {
      throw error;
    }
    throw new ImageScanError("image_scan_failed");
  }
}

function main(): void {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--positive-control") {
      runPositiveControl();
      return;
    }
    if (
      args.length !== 4 ||
      args[0] !== "--report" ||
      args[2] !== "--image" ||
      args[1] === undefined ||
      args[3] === undefined
    ) {
      throw new ImageScanError("image_scan_failed");
    }
    runReport(args[1], args[3]);
  } catch (error) {
    process.stderr.write(`${imageScanErrorCode(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
