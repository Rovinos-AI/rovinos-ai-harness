// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { reportGrade, reportTrial } from "../../test-utils/report.js";
import { buildEvalReport, serializeEvalReport } from "./json.js";
import { parseEvalTrialJsonl } from "./metrics.js";
import { EvalReportSchema } from "./schema.js";

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

  it("parses versioned trial JSONL and rejects missing grade associations", () => {
    const line = JSON.stringify(reportTrial());
    expect(parseEvalTrialJsonl(`${line}\n`)).toHaveLength(1);
    expect(() => parseEvalTrialJsonl('{"schemaVersion":2}\n')).toThrow();
    expect(() => buildEvalReport({ trials: [reportTrial()], grades: [] })).toThrow();
  });
});
