// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DetectionSchema, parseJson } from "@rovinos/schemas";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluatePiiReport,
  formatPiiReport,
  PiiReportSchema,
  PiiThresholdsSchema,
  runPiiReport,
  type PiiReport,
} from "./pii-report.js";
import { PiiCorpusSampleSchema } from "./gen-pii-corpus.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pii-report-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sample(id: string, spans: { start: number; end: number; entityType: string }[]) {
  return PiiCorpusSampleSchema.parse({ id, text: "abcdefghij", spans });
}

function detection(start: number, end: number, detectorId = "synthetic") {
  return DetectionSchema.parse({
    entityType: "email",
    start,
    end,
    confidence: 1,
    detectorId,
  });
}

function thresholds(regex: Record<string, { minPrecision: number; minRecall: number }> = {}) {
  return PiiThresholdsSchema.parse({ regex, presidio: {} });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("evaluatePiiReport", () => {
  it("computes exact and IoU-0.5 precision, recall, and F1", () => {
    const report = evaluatePiiReport(
      [
        sample("pii-exact", [{ start: 1, end: 5, entityType: "email" }]),
        sample("pii-overlap", [{ start: 1, end: 5, entityType: "email" }]),
        sample("pii-missed", [{ start: 1, end: 5, entityType: "email" }]),
        sample("pii-extra", []),
      ],
      [[detection(1, 5)], [detection(1, 4)], [], [detection(1, 5)]],
      "regex",
      thresholds(),
    );
    const email = report.entities.email;

    expect(email?.exact).toMatchObject({
      truePositive: 1,
      falsePositive: 2,
      falseNegative: 2,
      precision: 1 / 3,
      recall: 1 / 3,
      f1: 1 / 3,
    });
    expect(email?.iou50).toMatchObject({
      truePositive: 2,
      falsePositive: 1,
      falseNegative: 1,
      precision: 2 / 3,
      recall: 2 / 3,
      f1: 2 / 3,
    });
    expect(report.passed).toBe(true);
  });

  it("fails thresholds when precision is undefined even if the minimum is zero", () => {
    const report: PiiReport = evaluatePiiReport(
      [sample("pii-missed", [{ start: 1, end: 5, entityType: "email" }])],
      [[]],
      "regex",
      thresholds({ email: { minPrecision: 0, minRecall: 0 } }),
    );

    expect(report.passed).toBe(false);
    expect(report.entities.email?.passed).toBe(false);
    expect(report.entities.email?.exact.precision).toBeNull();
    expect(formatPiiReport(report)).toContain("email | n/a / 0.000 / 0.000");
  });

  it("counts agreeing detectors as one prediction", () => {
    const report = evaluatePiiReport(
      [sample("pii-agreeing-detectors", [{ start: 1, end: 5, entityType: "email" }])],
      [[detection(1, 5, "regex"), detection(1, 5, "presidio")]],
      "presidio",
      thresholds(),
    );

    expect(report.entities.email?.exact).toMatchObject({
      truePositive: 1,
      falsePositive: 0,
      falseNegative: 0,
      precision: 1,
      recall: 1,
    });
  });

  it("finds a maximum-cardinality assignment for overlapping spans", () => {
    const report = evaluatePiiReport(
      [
        sample("pii-iou-matching", [
          { start: 0, end: 4, entityType: "email" },
          { start: 4, end: 8, entityType: "email" },
        ]),
      ],
      [[detection(0, 8), detection(0, 2)]],
      "regex",
      thresholds(),
    );

    expect(report.entities.email?.iou50).toMatchObject({
      truePositive: 2,
      falsePositive: 0,
      falseNegative: 0,
      precision: 1,
      recall: 1,
    });
  });

  it("returns a non-zero status when a threshold fails", () => {
    const directory = temporaryDirectory();
    const corpusPath = join(directory, "corpus.jsonl");
    const thresholdsPath = join(directory, "thresholds.json");
    const outputDirectory = join(directory, "report");
    const location = PiiCorpusSampleSchema.parse({
      id: "pii-location-test",
      text: "The location is Paris.",
      spans: [{ start: 16, end: 21, entityType: "location" }],
    });
    writeFileSync(corpusPath, `${JSON.stringify(location)}\n`);
    writeFileSync(
      thresholdsPath,
      JSON.stringify({
        regex: { location: { minPrecision: 1, minRecall: 1 } },
        presidio: {},
      }),
    );

    const status = runPiiReport([
      "--mode",
      "regex",
      "--corpus",
      corpusPath,
      "--thresholds",
      thresholdsPath,
      "--out-dir",
      outputDirectory,
    ]);

    expect(status).toBe(1);
    expect(
      parseJson(PiiReportSchema, readFileSync(join(outputDirectory, "pii-report.json"), "utf8"))
        .passed,
    ).toBe(false);
  });
});
