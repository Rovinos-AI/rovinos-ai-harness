// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { EvalReportSchema } from "./schema.js";
import { buildEvalBaseline, checkEvalBaseline, serializeEvalBaseline } from "./baseline.js";
import type { EvalReport } from "./schema.js";

function report(
  options: {
    readonly passRate?: number;
    readonly tasks?: readonly string[];
    readonly privacyPass?: boolean;
  } = {},
): EvalReport {
  const tasks = options.tasks ?? ["task_one"];
  return EvalReportSchema.parse({
    schemaVersion: 1,
    trials: tasks.map((taskId) => ({
      taskId,
      variantId: "baseline",
      trialIndex: 0,
      status: options.privacyPass === false ? "failed" : "completed",
      passed: options.passRate !== undefined ? options.passRate === 1 : true,
      graders: [
        {
          graderId: "no_canary_leak",
          pass: options.privacyPass !== false,
          codes: options.privacyPass === false ? ["canary_in_logs"] : [],
        },
      ],
      steps: 1,
      inputTokens: 2,
      outputTokens: 3,
      costMicros: 4,
      wallTimeMs: 5,
      repairAttempts: 0,
      fallbackDepth: 0,
      approvals: { approved: 0, denied: 0, edited: 0 },
      deniedToolCalls: 0,
      budgetExceeded: false,
      unsafeAutoApprove: false,
    })),
    aggregates: tasks.map((taskId) => ({
      taskId,
      variantId: "baseline",
      n: 1,
      passes: options.passRate === 0 ? 0 : 1,
      passRate: options.passRate ?? 1,
      standardError: 0,
      passAtK: [{ k: 1, rate: options.passRate ?? 1 }],
      costMicros: { mean: 4, median: 4, p95: 4 },
      inputTokens: { mean: 2, median: 2, p95: 2 },
      outputTokens: { mean: 3, median: 3, p95: 3 },
      totalTokens: { mean: 5, median: 5, p95: 5 },
      steps: { mean: 1, median: 1, p95: 1 },
      latencyMs: { mean: 5, median: 5, p95: 5 },
    })),
  });
}

describe("eval baseline", () => {
  it("allows pass-rate drops within the threshold", () => {
    expect(
      checkEvalBaseline(buildEvalBaseline(report()), report({ passRate: 0.96 }), 0.05),
    ).toEqual({
      passed: true,
      regressions: [],
    });
  });

  it("flags pass-rate drops beyond the threshold", () => {
    expect(
      checkEvalBaseline(buildEvalBaseline(report()), report({ passRate: 0.94 }), 0.05),
    ).toMatchObject({
      passed: false,
      regressions: [{ code: "pass_rate_drop", taskId: "task_one", variantId: "baseline" }],
    });
  });

  it("allows new tasks and flags removed tasks", () => {
    const baseline = buildEvalBaseline(report());
    expect(
      checkEvalBaseline(baseline, report({ tasks: ["task_one", "task_two"] }), 0.05).passed,
    ).toBe(true);
    expect(checkEvalBaseline(baseline, report({ tasks: [] }), 0.05).regressions).toEqual([
      { code: "task_removed", taskId: "task_one", variantId: "baseline" },
    ]);
  });

  it("flags a previously passing privacy grader that fails or is missing", () => {
    const baseline = buildEvalBaseline(report());
    expect(checkEvalBaseline(baseline, report({ privacyPass: false }), 0.05).regressions).toEqual([
      {
        code: "privacy_assertion_failed",
        taskId: "task_one",
        variantId: "baseline",
        graderId: "no_canary_leak",
      },
    ]);
    const current = report();
    const withoutGrader = EvalReportSchema.parse({
      ...current,
      trials: current.trials.map((trial) => ({ ...trial, graders: [] })),
    });
    expect(checkEvalBaseline(baseline, withoutGrader, 0.05).regressions).toHaveLength(1);
  });

  it("serializes the baseline deterministically without trial data", () => {
    const baseline = buildEvalBaseline(report());
    expect(serializeEvalBaseline(baseline)).toBe(serializeEvalBaseline(baseline));
    expect(serializeEvalBaseline(baseline)).not.toContain('"trials"');
  });
});
