// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  creditCardDetector,
  DetectorRegistry,
  emailDetector,
  ibanDetector,
  ipDetector,
  phoneDetector,
  secretsDetector,
  urlCredentialsDetector,
} from "@harness/pii";
import type { Detection } from "@harness/pii";
import { DetectionSchema, parseJson } from "@harness/schemas";
import { z } from "zod";
import { PiiCorpusSampleSchema } from "./gen-pii-corpus.ts";

const PiiThresholdSchema = z
  .object({
    minPrecision: z.number().min(0).max(1),
    minRecall: z.number().min(0).max(1),
  })
  .strict();

/** Mode-specific minimum precision and recall for the synthetic corpus. */
export const PiiThresholdsSchema = z
  .object({
    regex: z.record(z.string(), PiiThresholdSchema),
    presidio: z.record(z.string(), PiiThresholdSchema),
  })
  .strict();

/** Validated corpus quality thresholds. */
export type PiiThresholds = z.infer<typeof PiiThresholdsSchema>;

const PiiMetricSchema = z
  .object({
    truePositive: z.number().int().nonnegative(),
    falsePositive: z.number().int().nonnegative(),
    falseNegative: z.number().int().nonnegative(),
    precision: z.number().min(0).max(1),
    recall: z.number().min(0).max(1),
    f1: z.number().min(0).max(1),
  })
  .strict();

const PiiEntityReportSchema = z
  .object({
    exact: PiiMetricSchema,
    iou50: PiiMetricSchema,
    threshold: PiiThresholdSchema.nullable(),
    passed: z.boolean(),
  })
  .strict();

/** Machine-readable precision and recall results without sample text or spans. */
export const PiiReportSchema = z
  .object({
    mode: z.enum(["regex", "presidio"]),
    sampleCount: z.number().int().positive(),
    passed: z.boolean(),
    entities: z.record(z.string(), PiiEntityReportSchema),
  })
  .strict();

/** Validated detector quality report. */
export type PiiReport = z.infer<typeof PiiReportSchema>;

type PiiCorpusSample = z.infer<typeof PiiCorpusSampleSchema>;
type PiiCorpusSpan = PiiCorpusSample["spans"][number];

interface MatchCounts {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
}

const corpusPath = fileURLToPath(new URL("../test/pii-corpus/corpus.jsonl", import.meta.url));
const thresholdsPath = fileURLToPath(new URL("../test/pii-corpus/thresholds.json", import.meta.url));

/** Computes precision, recall, F1, exact matches, and the IoU >= 0.5 fallback. */
export function evaluatePiiReport(
  samples: readonly PiiCorpusSample[],
  detections: readonly (readonly Detection[])[],
  mode: "regex" | "presidio",
  thresholds: PiiThresholds,
): PiiReport {
  if (samples.length === 0 || samples.length !== detections.length) {
    throw new Error("PII report input is invalid.");
  }

  const entityTypes = new Set<string>();
  for (const [index, sample] of samples.entries()) {
    for (const span of sample.spans) {
      entityTypes.add(span.entityType);
    }
    for (const detection of detections[index] ?? []) {
      entityTypes.add(detection.entityType);
    }
  }

  const thresholdSet = thresholds[mode];
  const entities: Record<string, z.infer<typeof PiiEntityReportSchema>> = {};
  let passed = true;
  for (const entityType of [...entityTypes].sort()) {
    let exactCounts: MatchCounts = { truePositive: 0, falsePositive: 0, falseNegative: 0 };
    let iou50Counts: MatchCounts = { truePositive: 0, falsePositive: 0, falseNegative: 0 };
    for (const [index, sample] of samples.entries()) {
      const gold = sample.spans.filter((span) => span.entityType === entityType);
      const predicted = (detections[index] ?? []).filter(
        (detection) => detection.entityType === entityType,
      );
      exactCounts = addCounts(exactCounts, matchCounts(gold, predicted, 1));
      iou50Counts = addCounts(iou50Counts, matchCounts(gold, predicted, 0.5));
    }
    const threshold = thresholdSet[entityType] ?? null;
    const exact = toMetric(exactCounts);
    const iou50 = toMetric(iou50Counts);
    const entityPassed =
      threshold === null ||
      (exact.precision >= threshold.minPrecision && exact.recall >= threshold.minRecall);
    entities[entityType] = { exact, iou50, threshold, passed: entityPassed };
    passed &&= entityPassed;
  }

  return PiiReportSchema.parse({ mode, sampleCount: samples.length, passed, entities });
}

function addCounts(total: MatchCounts, counts: MatchCounts): MatchCounts {
  return {
    truePositive: total.truePositive + counts.truePositive,
    falsePositive: total.falsePositive + counts.falsePositive,
    falseNegative: total.falseNegative + counts.falseNegative,
  };
}

function intersectionOverUnion(gold: PiiCorpusSpan, prediction: Detection): number {
  const intersection = Math.max(
    0,
    Math.min(gold.end, prediction.end) - Math.max(gold.start, prediction.start),
  );
  if (intersection === 0) {
    return 0;
  }
  const union = Math.max(gold.end, prediction.end) - Math.min(gold.start, prediction.start);
  return intersection / union;
}

function matchCounts(
  gold: readonly PiiCorpusSpan[],
  predictions: readonly Detection[],
  minimumIou: number,
): MatchCounts {
  const candidates: { readonly goldIndex: number; readonly predictionIndex: number; readonly iou: number }[] =
    [];
  for (const [goldIndex, expected] of gold.entries()) {
    for (const [predictionIndex, prediction] of predictions.entries()) {
      const iou = intersectionOverUnion(expected, prediction);
      const matches =
        minimumIou === 1
          ? expected.start === prediction.start && expected.end === prediction.end
          : iou >= minimumIou;
      if (matches) {
        candidates.push({ goldIndex, predictionIndex, iou });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      right.iou - left.iou ||
      left.goldIndex - right.goldIndex ||
      left.predictionIndex - right.predictionIndex,
  );

  const matchedGold = new Set<number>();
  const matchedPredictions = new Set<number>();
  for (const candidate of candidates) {
    if (
      !matchedGold.has(candidate.goldIndex) &&
      !matchedPredictions.has(candidate.predictionIndex)
    ) {
      matchedGold.add(candidate.goldIndex);
      matchedPredictions.add(candidate.predictionIndex);
    }
  }
  const truePositive = matchedGold.size;
  return {
    truePositive,
    falsePositive: predictions.length - matchedPredictions.size,
    falseNegative: gold.length - matchedGold.size,
  };
}

function toMetric(counts: MatchCounts): z.infer<typeof PiiMetricSchema> {
  const precisionDenominator = counts.truePositive + counts.falsePositive;
  const recallDenominator = counts.truePositive + counts.falseNegative;
  const precision =
    precisionDenominator === 0 ? 1 : counts.truePositive / precisionDenominator;
  const recall = recallDenominator === 0 ? 1 : counts.truePositive / recallDenominator;
  return {
    ...counts,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

/** Formats a report as Markdown without including corpus text or detector output. */
export function formatPiiReport(report: PiiReport): string {
  const lines = [
    "# Synthetic PII detector report",
    "",
    `- Mode: ${report.mode}`,
    `- Samples: ${report.sampleCount}`,
    `- Thresholds: ${report.passed ? "PASS" : "FAIL"}`,
    "",
    "| Entity | Exact P / R / F1 | IoU ≥ 0.5 P / R / F1 | Threshold | Status |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const [entityType, result] of Object.entries(report.entities).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const threshold =
      result.threshold === null
        ? "not set"
        : `${result.threshold.minPrecision}/${result.threshold.minRecall}`;
    lines.push(
      `| ${entityType} | ${formatMetric(result.exact)} | ${formatMetric(result.iou50)} | ${threshold} | ${result.passed ? "PASS" : "FAIL"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatMetric(metric: z.infer<typeof PiiMetricSchema>): string {
  return [metric.precision, metric.recall, metric.f1].map((value) => value.toFixed(3)).join(" / ");
}

function readCorpus(path: string): PiiCorpusSample[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error("PII corpus is empty.");
  }
  return lines.map((line) => parseJson(PiiCorpusSampleSchema, line));
}

function regexRegistry(): DetectorRegistry {
  return new DetectorRegistry({
    syncDetectors: [
      emailDetector,
      phoneDetector,
      creditCardDetector,
      ibanDetector,
      ipDetector,
      secretsDetector,
      urlCredentialsDetector,
    ],
  });
}

function collectPresidioDetections(texts: readonly string[]): Detection[][] {
  const runner = [
    'import { DetectorRegistry, emailDetector, phoneDetector, creditCardDetector, ibanDetector, ipDetector, secretsDetector, urlCredentialsDetector, PresidioDetector } from "@harness/pii";',
    'import { PiiPresidioConfigSchema, parseJson } from "@harness/schemas";',
    'import { z } from "zod";',
    'const input = await new Promise((resolve, reject) => { let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { text += chunk; }); process.stdin.on("end", () => resolve(text)); process.stdin.on("error", reject); });',
    "const texts = parseJson(z.array(z.string()), input);",
    'const presidio = new PresidioDetector(PiiPresidioConfigSchema.parse({ baseUrl: "http://presidio-analyzer:3000" }));',
    "const registry = new DetectorRegistry({ syncDetectors: [emailDetector, phoneDetector, creditCardDetector, ibanDetector, ipDetector, secretsDetector, urlCredentialsDetector], asyncDetectors: [presidio] });",
    "const results = [];",
    "for (const text of texts) results.push(await registry.detect(text));",
    "process.stdout.write(JSON.stringify(results));",
  ].join("\n");
  const output = execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      "infra/collector/VERSION",
      "--file",
      "infra/compose/docker-compose.test.yml",
      "exec",
      "-T",
      "harness",
      "node",
      "--input-type=module",
      "-e",
      runner,
    ],
    {
      encoding: "utf8",
      input: JSON.stringify(texts),
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  return parseJson(z.array(z.array(DetectionSchema)), output);
}

function collectRegexDetections(samples: readonly PiiCorpusSample[]): Detection[][] {
  const registry = regexRegistry();
  return samples.map((sample) => {
    const result = registry.detect(sample.text);
    if (result instanceof Promise) {
      throw new Error("Unexpected asynchronous regex detector.");
    }
    return result;
  });
}

interface ReportOptions {
  readonly mode: "regex" | "presidio";
  readonly corpusPath: string;
  readonly thresholdsPath: string;
  readonly outputDirectory: string;
}

function parseOptions(args: readonly string[]): ReportOptions {
  let mode: ReportOptions["mode"] = "regex";
  let inputCorpus = corpusPath;
  let inputThresholds = thresholdsPath;
  let outputDirectory = "reports/pii";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--mode" && (value === "regex" || value === "presidio")) {
      mode = value;
      index++;
    } else if (argument === "--corpus" && value !== undefined) {
      inputCorpus = value;
      index++;
    } else if (argument === "--thresholds" && value !== undefined) {
      inputThresholds = value;
      index++;
    } else if (argument === "--out-dir" && value !== undefined) {
      outputDirectory = value;
      index++;
    } else {
      throw new Error("Unsupported PII report argument.");
    }
  }
  return {
    mode,
    corpusPath: resolve(inputCorpus),
    thresholdsPath: resolve(inputThresholds),
    outputDirectory: resolve(outputDirectory),
  };
}

async function runPiiReport(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const samples = readCorpus(options.corpusPath);
  const thresholds = parseJson(PiiThresholdsSchema, readFileSync(options.thresholdsPath, "utf8"));
  const detections =
    options.mode === "presidio"
      ? collectPresidioDetections(samples.map((sample) => sample.text))
      : collectRegexDetections(samples);
  const report = evaluatePiiReport(samples, detections, options.mode, thresholds);
  mkdirSync(options.outputDirectory, { recursive: true });
  writeFileSync(
    resolve(options.outputDirectory, "pii-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(resolve(options.outputDirectory, "pii-report.md"), formatPiiReport(report));
  return report.passed ? 0 : 1;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  void runPiiReport(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.stderr.write("PII report failed; detector values are not included.\n");
      process.exitCode = 1;
    });
}
