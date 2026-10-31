// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { reportGrade, reportTrial } from "../../test-utils/report.js";
import { buildEvalReport, serializeEvalReport } from "./json.js";
import { parseEvalTrialJsonl } from "./metrics.js";
import { EvalAggregateSchema, EvalReportSchema } from "./schema.js";

describe("eval JSON reports", () => {
  it("validates the versioned report and serializes deterministically without content", () => {
    const trials = [
      reportTrial({
        trialIndex: 1,
        result: {
          dbPath: "/synthetic/private/trial.db",
          workspaceDir: "/synthetic/private/workspace",
          usage: { inputTokens: 4, outputTokens: 5, costMicros: 10 },
          durationMs: 20,
        },
      }),
      reportTrial({
        trialIndex: 0,
        result: {
          dbPath: "/synthetic/private/trial.db",
          workspaceDir: "/synthetic/private/workspace",
          usage: { inputTokens: 2, outputTokens: 3, costMicros: 5 },
          durationMs: 10,
        },
      }),
    ];
    const input = {
      trials,
      grades: [
        {
          taskId: "task_one",
          variantId: "baseline",
          trialIndex: 1,
          graders: [reportGrade(false, ["content_mismatch"])],
        },
        { taskId: "task_one", variantId: "baseline", trialIndex: 0, graders: [reportGrade(true)] },
      ],
    };
    const report = buildEvalReport(input);
    const first = serializeEvalReport(report);
    const second = serializeEvalReport(buildEvalReport(input));
    const parsed = parseJson(EvalReportSchema, first);

    expect(first).toBe(second);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.invariantsEnabled).toBe(true);
    expect(parsed.trials.map(({ trialIndex }) => trialIndex)).toEqual([0, 1]);
    expect(parsed.aggregates[0]).toMatchObject({
      n: 2,
      passes: 1,
      passRate: 0.5,
      costMicros: { mean: 7.5, median: 7.5, p95: 10 },
    });

    expect(first.indexOf('"aggregates"')).toBeLessThan(first.indexOf('"schemaVersion"'));
    expect(first).not.toContain("/synthetic/private");
    expect(first).not.toContain("goal");
    expect(first).not.toContain("transcript");
  });

  it("records when a suite explicitly disables invariant checks", () => {
    const report = buildEvalReport({
      trials: [reportTrial()],
      grades: [
        { taskId: "task_one", variantId: "baseline", trialIndex: 0, graders: [reportGrade(true)] },
      ],
      invariantsEnabled: false,
    });

    expect(report.invariantsEnabled).toBe(false);
  });

  it("parses versioned trial JSONL and rejects missing grade associations", () => {
    const line = JSON.stringify(reportTrial());
    expect(parseEvalTrialJsonl(`${line}\n`)).toHaveLength(1);
    expect(() => parseEvalTrialJsonl('{"schemaVersion":2}\n')).toThrow();
    expect(() => buildEvalReport({ trials: [reportTrial()], grades: [] })).toThrow();
  });

  it("rejects duplicate and unassociated grade records and invalid aggregate counts", () => {
    const trial = reportTrial();
    const grade = {
      taskId: "task_one",
      variantId: "baseline",
      trialIndex: 0,
      graders: [reportGrade(true)],
    };

    expect(() => buildEvalReport({ trials: [trial, trial], grades: [grade] })).toThrow();
    expect(() => buildEvalReport({ trials: [trial], grades: [grade, grade] })).toThrow();
    expect(() =>
      buildEvalReport({
        trials: [trial],
        grades: [{ ...grade, taskId: "task_other" }],
      }),
    ).toThrow();
    expect(
      EvalAggregateSchema.safeParse({
        taskId: "task_one",
        variantId: "baseline",
        n: 1,
        passes: 2,
        passRate: 1,
        standardError: 0,
        passAtK: [],
        costMicros: { mean: 0, median: 0, p95: 0 },
        inputTokens: { mean: 0, median: 0, p95: 0 },
        outputTokens: { mean: 0, median: 0, p95: 0 },
        totalTokens: { mean: 0, median: 0, p95: 0 },
        steps: { mean: 0, median: 0, p95: 0 },
        latencyMs: { mean: 0, median: 0, p95: 0 },
      }).success,
    ).toBe(false);
  });

  it("orders serialized tasks and variants in stable report output", () => {
    const report = buildEvalReport({
      trials: [
        reportTrial({ taskId: "task_b", variantId: "variant_b" }),
        reportTrial({ taskId: "task_a", variantId: "variant_b" }),
        reportTrial({ taskId: "task_a", variantId: "variant_a", trialIndex: 1 }),
      ],
      grades: [
        {
          taskId: "task_b",
          variantId: "variant_b",
          trialIndex: 0,
          graders: [reportGrade(true)],
        },
        {
          taskId: "task_a",
          variantId: "variant_b",
          trialIndex: 0,
          graders: [reportGrade(true)],
        },
        {
          taskId: "task_a",
          variantId: "variant_a",
          trialIndex: 1,
          graders: [reportGrade(true)],
        },
      ],
    });
    const json = serializeEvalReport(report);
    expect(json.indexOf('"taskId": "task_a"')).toBeLessThan(json.indexOf('"taskId": "task_b"'));
    expect(json.indexOf('"variantId": "variant_a"')).toBeLessThan(
      json.indexOf('"variantId": "variant_b"'),
    );
  });
});
