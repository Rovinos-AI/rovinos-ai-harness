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

  it("allows new variants absent from the baseline", () => {
    const baseline = buildEvalBaseline(report());
    const current = report();
    const currentTrial = current.trials[0];
    const currentAggregate = current.aggregates[0];
    if (currentTrial === undefined || currentAggregate === undefined) {
      throw new Error("Expected report fixture entries");
    }

    const withNewVariant = EvalReportSchema.parse({
      ...current,
      trials: [...current.trials, { ...currentTrial, variantId: "new_variant" }],
      aggregates: [...current.aggregates, { ...currentAggregate, variantId: "new_variant" }],
    });

    expect(checkEvalBaseline(baseline, withNewVariant, 0.05).passed).toBe(true);
  });

  it("allows a pass-rate drop exactly at the configured threshold", () => {
    const baseline = buildEvalBaseline(report({ passRate: 0.5 }));

    expect(checkEvalBaseline(baseline, report({ passRate: 0.25 }), 0.25)).toEqual({
      passed: true,
      regressions: [],
    });
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

  it("sorts aggregate and privacy entries by task, variant, trial, and grader", () => {
    const baseline = buildEvalBaseline(report());
    const firstAggregate = baseline.aggregates[0];
    if (firstAggregate === undefined) {
      throw new Error("Expected report aggregate fixture");
    }
    const serialized = serializeEvalBaseline({
      ...baseline,
      aggregates: [
        { ...firstAggregate, taskId: "task_two", variantId: "variant_two" },
        { ...firstAggregate, variantId: "variant_two" },
        firstAggregate,
      ],
      passingPrivacyAssertions: [
        { taskId: "task_two", variantId: "variant_two", trialIndex: 0, graderId: "trajectory" },
        { taskId: "task_one", variantId: "variant_two", trialIndex: 1, graderId: "trajectory" },
        { taskId: "task_one", variantId: "variant_two", trialIndex: 0, graderId: "trajectory" },
        {
          taskId: "task_one",
          variantId: "variant_two",
          trialIndex: 0,
          graderId: "no_canary_leak",
        },
        { taskId: "task_one", variantId: "baseline", trialIndex: 0, graderId: "no_canary_leak" },
      ],
    });
    const sorted = serializeEvalBaseline({
      ...baseline,
      aggregates: [
        firstAggregate,
        { ...firstAggregate, variantId: "variant_two" },
        { ...firstAggregate, taskId: "task_two", variantId: "variant_two" },
      ],
      passingPrivacyAssertions: [
        { taskId: "task_one", variantId: "baseline", trialIndex: 0, graderId: "no_canary_leak" },
        {
          taskId: "task_one",
          variantId: "variant_two",
          trialIndex: 0,
          graderId: "no_canary_leak",
        },
        { taskId: "task_one", variantId: "variant_two", trialIndex: 0, graderId: "trajectory" },
        { taskId: "task_one", variantId: "variant_two", trialIndex: 1, graderId: "trajectory" },
        { taskId: "task_two", variantId: "variant_two", trialIndex: 0, graderId: "trajectory" },
      ],
    });

    expect(serialized).toBe(sorted);
  });
});
