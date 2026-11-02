// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { compareEvalReports, renderComparisonTable } from "./compare.js";
import { EvalReportSchema } from "./schema.js";

function report(variantId: string, passes: readonly boolean[], seedOffset = 0) {
  return EvalReportSchema.parse({
    schemaVersion: 1,
    trials: passes.map((passed, trialIndex) => ({
      taskId: "task_one",
      variantId,
      trialIndex,
      seed: seedOffset + trialIndex,
      status: "completed",
      passed,
      graders: [],
      steps: passed ? 1 : 2,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: passed ? 10 : 20,
      wallTimeMs: passed ? 100 : 200,
      repairAttempts: 0,
      fallbackDepth: 0,
      approvals: { approved: 0, denied: 0, edited: 0 },
      deniedToolCalls: 0,
      budgetExceeded: false,
      unsafeAutoApprove: false,
    })),
    aggregates: [],
  });
}

describe("evaluation report comparison", () => {
  it("labels small samples inconclusive and counts matching same-seed trial identities", () => {
    const result = compareEvalReports(
      report("baseline", [true, false, true]),
      report("candidate", [true, true, true]),
    );
    const task = result.comparisons[0];
    expect(task).toMatchObject({ scope: "task", matchedTrials: 3, trialsA: 3, trialsB: 3 });
    expect(task?.metrics.every(({ verdict }) => verdict === "inconclusive")).toBe(true);
    expect(
      compareEvalReports(
        report("baseline", [true, false, true], 3),
        report("candidate", [true, true, true]),
      ).comparisons[0]?.matchedTrials,
    ).toBe(0);
    expect(result.comparisons.at(-1)?.scope).toBe("overall");
  });

  it("corrects task pass-rate p-values and displays both values in the table", () => {
    const reportA = {
      ...report(
        "baseline",
        Array.from({ length: 20 }, (_, index) => index < 10),
      ),
      trials: [
        ...report(
          "baseline",
          Array.from({ length: 20 }, (_, index) => index < 10),
        ).trials,
        ...report(
          "baseline",
          Array.from({ length: 20 }, (_, index) => index < 10),
        ).trials.map((trial) => ({ ...trial, taskId: "task_two" })),
      ],
    };
    const reportB = {
      ...report(
        "candidate",
        Array.from({ length: 20 }, (_, index) => index < 18),
      ),
      trials: [
        ...report(
          "candidate",
          Array.from({ length: 20 }, (_, index) => index < 18),
        ).trials,
        ...report(
          "candidate",
          Array.from({ length: 20 }, (_, index) => index < 18),
        ).trials.map((trial) => ({ ...trial, taskId: "task_two" })),
      ],
    };
    const result = compareEvalReports(reportA, reportB, { seed: 11 });
    const passMetric = result.comparisons[0]?.metrics.find(({ metric }) => metric === "pass_rate");
    expect(passMetric?.pValue).toBeLessThan(0.05);
    expect(passMetric?.adjustedPValue).toBeGreaterThanOrEqual(passMetric?.pValue ?? 1);
    expect(passMetric?.verdict).toBe("better");
    expect(result.comparisons.at(-1)?.metrics[0]?.verdict).toBe("better");
    expect(renderComparisonTable(result)).toContain("A: baseline\tB: candidate");
    expect(renderComparisonTable(result)).toContain("Adjusted p");
    expect(renderComparisonTable(result)).toContain("pass_rate");
  });

  it("requires explicit variant selection for reports with multiple variants", () => {
    const multiVariant = {
      ...report("baseline", [true]),
      trials: [...report("baseline", [true]).trials, ...report("other", [false]).trials],
    };
    expect(() => compareEvalReports(multiVariant, report("candidate", [true]))).toThrow(
      expect.objectContaining({ code: "eval_compare_variant_required" }),
    );
    expect(
      compareEvalReports(multiVariant, report("candidate", [true]), {
        variantA: "baseline",
      }).comparisons,
    ).toHaveLength(2);
  });
});
