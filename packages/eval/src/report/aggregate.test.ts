// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { aggregateEvalMetrics, passAtK, summarize } from "./aggregate.js";
import { EvalTrialMetricsSchema } from "./schema.js";

function metric(trialIndex: number, passed: boolean, costMicros = 0) {
  return EvalTrialMetricsSchema.parse({
    taskId: "task_one",
    variantId: "baseline",
    trialIndex,
    status: "completed",
    passed,
    graders: [],
    steps: trialIndex + 1,
    inputTokens: trialIndex + 1,
    outputTokens: trialIndex + 2,
    costMicros,
    wallTimeMs: trialIndex + 10,
    repairAttempts: 0,
    fallbackDepth: 0,
    approvals: { approved: 0, denied: 0, edited: 0 },
    deniedToolCalls: 0,
    budgetExceeded: false,
    unsafeAutoApprove: false,
  });
}

describe("eval report aggregation", () => {
  it("matches the unbiased pass@k reference values", () => {
    expect([1, 2, 3, 4, 5].map((k) => passAtK(5, 2, k))).toEqual([0.4, 0.7, 0.9, 1, 1]);
    expect([1, 2, 3, 4, 5].map((k) => passAtK(5, 0, k))).toEqual([0, 0, 0, 0, 0]);
    expect([1, 2, 3, 4, 5].map((k) => passAtK(5, 5, k))).toEqual([1, 1, 1, 1, 1]);
    expect(() => passAtK(2, 3, 1)).toThrow();
    expect(() => passAtK(2, 1, 0)).toThrow();
  });

  it("uses the nearest-rank p95 and an averaged even-sample median", () => {
    expect(summarize([1, 2, 3, 4, 5])).toEqual({ mean: 3, median: 3, p95: 5 });
    expect(summarize([1, 2, 3, 4])).toEqual({ mean: 2.5, median: 2.5, p95: 4 });
    expect(() => summarize([])).toThrow();
  });

  it("computes rates, standard error, and metric summaries per task and variant", () => {
    const report = aggregateEvalMetrics([
      metric(0, true, 10),
      metric(1, true, 20),
      metric(2, false, 30),
      metric(3, false, 40),
      metric(4, false, 50),
    ]);

    expect(report[0]).toMatchObject({
      n: 5,
      passes: 2,
      passRate: 0.4,
      standardError: Math.sqrt((0.4 * 0.6) / 5),
      passAtK: [
        { k: 1, rate: 0.4 },
        { k: 2, rate: 0.7 },
        { k: 3, rate: 0.9 },
        { k: 4, rate: 1 },
        { k: 5, rate: 1 },
      ],
      costMicros: { mean: 30, median: 30, p95: 50 },
      inputTokens: { mean: 3, median: 3, p95: 5 },
      outputTokens: { mean: 4, median: 4, p95: 6 },
      totalTokens: { mean: 7, median: 7, p95: 11 },
      steps: { mean: 3, median: 3, p95: 5 },
      latencyMs: { mean: 12, median: 12, p95: 14 },
    });
  });

  it("sorts multiple task and variant groups independently of input order", () => {
    const report = aggregateEvalMetrics([
      metric(0, true),
      EvalTrialMetricsSchema.parse({ ...metric(0, true), taskId: "task_b" }),
      EvalTrialMetricsSchema.parse({ ...metric(0, true), variantId: "variant_z" }),
    ]);

    expect(report.map(({ taskId, variantId }) => `${taskId}/${variantId}`)).toEqual([
      "task_b/baseline",
      "task_one/baseline",
      "task_one/variant_z",
    ]);
  });
});
