// SPDX-License-Identifier: Apache-2.0
import { Code, HarnessError } from "@rovinos/schemas";
import { z } from "zod";
import { bootstrapMeanDifference, fisherExactTest, holmBonferroni } from "../stats.js";
import { EvalReportSchema } from "./schema.js";
import type { EvalReport, EvalTrialMetrics } from "./schema.js";

const ComparisonMetricSchema = z.enum(["pass_rate", "cost_micros", "steps", "latency_ms"]);
const ConfidenceIntervalSchema = z
  .object({ low: z.number(), high: z.number() })
  .strict()
  .superRefine(({ low, high }, context) => {
    if (low > high) {
      context.addIssue({
        code: "custom",
        message: "Confidence interval lower bound must not exceed its upper bound.",
        params: { errorCode: "eval_compare_interval_invalid" },
      });
    }
  });

/** One content-free metric row in a report comparison. */
export const EvalComparisonMetricSchema = z
  .object({
    metric: ComparisonMetricSchema,
    a: z.number().nonnegative(),
    b: z.number().nonnegative(),
    delta: z.number(),
    effectSize: z.number(),
    confidenceInterval: ConfidenceIntervalSchema.nullable(),
    pValue: z.number().min(0).max(1).nullable(),
    adjustedPValue: z.number().min(0).max(1).nullable(),
    verdict: z.enum(["better", "worse", "inconclusive"]),
  })
  .strict();

/** Inferred content-free comparison result for one metric. */
export type EvalComparisonMetric = z.infer<typeof EvalComparisonMetricSchema>;

/** One task or overall report comparison. */
export const EvalComparisonSchema = z
  .object({
    scope: z.enum(["task", "overall"]),
    taskId: Code.optional(),
    variantA: Code,
    variantB: Code,
    trialsA: z.number().int().nonnegative(),
    trialsB: z.number().int().nonnegative(),
    matchedTrials: z.number().int().nonnegative(),
    metrics: z.array(EvalComparisonMetricSchema),
  })
  .strict()
  .superRefine((comparison, context) => {
    if ((comparison.scope === "task") !== (comparison.taskId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["taskId"],
        message: "Task comparisons require a task id; overall comparisons do not.",
        params: { errorCode: "eval_compare_scope_invalid" },
      });
    }
    if (comparison.matchedTrials > Math.min(comparison.trialsA, comparison.trialsB)) {
      context.addIssue({
        code: "custom",
        path: ["matchedTrials"],
        message: "Matched trials cannot exceed either sample count.",
        params: { errorCode: "eval_compare_match_count_invalid" },
      });
    }
  });

/** Inferred task-level or overall comparison. */
export type EvalComparison = z.infer<typeof EvalComparisonSchema>;

/** Versioned comparison report with metadata-only statistics. */
export const EvalComparisonReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    comparisons: z.array(EvalComparisonSchema),
  })
  .strict();

/** Inferred versioned comparison report. */
export type EvalComparisonReport = z.infer<typeof EvalComparisonReportSchema>;

const ComparisonOptionsSchema = z
  .object({
    variantA: Code.optional(),
    variantB: Code.optional(),
    seed: z.number().int().nonnegative().max(0xffff_ffff).default(0),
  })
  .strict();

/** Options selecting variants and the deterministic bootstrap seed. */
export type ComparisonOptions = z.input<typeof ComparisonOptionsSchema>;

class EvalComparisonError extends HarnessError {
  override readonly code:
    | "eval_compare_variant_required"
    | "eval_compare_variant_missing"
    | "eval_compare_tasks_mismatch"
    | "eval_compare_no_trials";

  constructor(
    code:
      | "eval_compare_variant_required"
      | "eval_compare_variant_missing"
      | "eval_compare_tasks_mismatch"
      | "eval_compare_no_trials",
  ) {
    super(code);
    this.code = code;
  }
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function variantIds(report: EvalReport): string[] {
  return [...new Set(report.trials.map(({ variantId }) => variantId))].sort(compareText);
}

function selectVariant(report: EvalReport, requested: string | undefined): string {
  const ids = variantIds(report);
  if (requested !== undefined) {
    if (!ids.includes(requested)) {
      throw new EvalComparisonError("eval_compare_variant_missing");
    }
    return requested;
  }
  if (ids.length !== 1) {
    throw new EvalComparisonError("eval_compare_variant_required");
  }
  const selected = ids[0];
  if (selected === undefined) {
    throw new EvalComparisonError("eval_compare_no_trials");
  }
  return selected;
}

function taskIds(reportA: EvalReport, reportB: EvalReport): string[] {
  const tasksA = [...new Set(reportA.trials.map(({ taskId }) => taskId))].sort(compareText);
  const tasksB = [...new Set(reportB.trials.map(({ taskId }) => taskId))].sort(compareText);
  if (tasksA.length !== tasksB.length || tasksA.some((taskId, index) => taskId !== tasksB[index])) {
    throw new EvalComparisonError("eval_compare_tasks_mismatch");
  }
  return tasksA;
}

function selectedTrials(
  report: EvalReport,
  variantId: string,
  taskId?: string,
): EvalTrialMetrics[] {
  return report.trials.filter(
    (trial) => trial.variantId === variantId && (taskId === undefined || trial.taskId === taskId),
  );
}

function matchedTrials(trialsA: readonly EvalTrialMetrics[], trialsB: readonly EvalTrialMetrics[]) {
  const seedsA = new Map(
    trialsA
      .filter(({ seed }) => seed !== undefined)
      .map(({ trialIndex, seed }) => [trialIndex, seed]),
  );
  return trialsB.filter(
    ({ trialIndex, seed }) => seed !== undefined && seedsA.get(trialIndex) === seed,
  ).length;
}

function hashSeed(seed: number, taskId: string, metric: string): number {
  let value = seed ^ 0x811c9dc5;
  for (const character of `${taskId}\u0000${metric}`) {
    value = Math.imul(value ^ character.charCodeAt(0), 0x01000193);
  }
  return value >>> 0;
}

function metricValues(
  trials: readonly EvalTrialMetrics[],
  metric: "cost_micros" | "steps" | "latency_ms",
): number[] {
  switch (metric) {
    case "cost_micros":
      return trials.map(({ costMicros }) => costMicros);
    case "steps":
      return trials.map(({ steps }) => steps);
    case "latency_ms":
      return trials.map(({ wallTimeMs }) => wallTimeMs);
  }
}

function passMetric(
  trialsA: readonly EvalTrialMetrics[],
  trialsB: readonly EvalTrialMetrics[],
  adjustedPValue: number | null,
): EvalComparisonMetric {
  const passesA = trialsA.filter(({ passed }) => passed).length;
  const passesB = trialsB.filter(({ passed }) => passed).length;
  const passRateA = passesA / trialsA.length;
  const passRateB = passesB / trialsB.length;
  const pValue = fisherExactTest({
    passedA: passesA,
    failedA: trialsA.length - passesA,
    passedB: passesB,
    failedB: trialsB.length - passesB,
  });
  const delta = passRateB - passRateA;
  return EvalComparisonMetricSchema.parse({
    metric: "pass_rate",
    a: passRateA,
    b: passRateB,
    delta,
    effectSize: delta,
    confidenceInterval: null,
    pValue,
    adjustedPValue,
    verdict: "inconclusive",
  });
}

function numericalMetric(args: {
  readonly trialsA: readonly EvalTrialMetrics[];
  readonly trialsB: readonly EvalTrialMetrics[];
  readonly metric: "cost_micros" | "steps" | "latency_ms";
  readonly seed: number;
  readonly taskId: string;
}): EvalComparisonMetric {
  const { trialsA, trialsB, metric, seed, taskId } = args;
  const estimate = bootstrapMeanDifference(
    metricValues(trialsA, metric),
    metricValues(trialsB, metric),
    hashSeed(seed, taskId, metric),
  );
  return EvalComparisonMetricSchema.parse({
    metric,
    a: estimate.meanA,
    b: estimate.meanB,
    delta: estimate.delta,
    effectSize: estimate.delta,
    confidenceInterval: { low: estimate.ciLow, high: estimate.ciHigh },
    pValue: null,
    adjustedPValue: null,
    verdict: "inconclusive",
  });
}

function withVerdict(
  metric: EvalComparisonMetric,
  trialsA: readonly EvalTrialMetrics[],
  trialsB: readonly EvalTrialMetrics[],
): EvalComparisonMetric {
  if (trialsA.length < 10 || trialsB.length < 10) {
    return metric;
  }
  if (metric.metric === "pass_rate") {
    if (metric.adjustedPValue === null || metric.adjustedPValue >= 0.05) {
      return metric;
    }
    return EvalComparisonMetricSchema.parse({
      ...metric,
      verdict: metric.delta > 0 ? "better" : "worse",
    });
  }
  const interval = metric.confidenceInterval;
  if (interval === null || (interval.low <= 0 && interval.high >= 0)) {
    return metric;
  }
  return EvalComparisonMetricSchema.parse({
    ...metric,
    verdict: metric.delta < 0 ? "better" : "worse",
  });
}

function compareGroup(args: {
  readonly reportA: EvalReport;
  readonly reportB: EvalReport;
  readonly variantA: string;
  readonly variantB: string;
  readonly options: z.infer<typeof ComparisonOptionsSchema>;
  readonly taskId?: string;
  readonly adjustedPassPValue?: number | null;
}): EvalComparison {
  const { reportA, reportB, variantA, variantB, options, taskId, adjustedPassPValue = null } = args;
  const trialsA = selectedTrials(reportA, variantA, taskId);
  const trialsB = selectedTrials(reportB, variantB, taskId);
  if (trialsA.length === 0 || trialsB.length === 0) {
    throw new EvalComparisonError("eval_compare_no_trials");
  }
  const comparisonKey = taskId ?? "overall";
  const pass = passMetric(trialsA, trialsB, adjustedPassPValue);
  const passWithOverallPValue =
    taskId === undefined
      ? EvalComparisonMetricSchema.parse({ ...pass, adjustedPValue: pass.pValue })
      : pass;
  const metrics = [
    withVerdict(passWithOverallPValue, trialsA, trialsB),
    ...(["cost_micros", "steps", "latency_ms"] as const).map((metric) =>
      withVerdict(
        numericalMetric({
          trialsA,
          trialsB,
          metric,
          seed: options.seed,
          taskId: comparisonKey,
        }),
        trialsA,
        trialsB,
      ),
    ),
  ];
  return EvalComparisonSchema.parse({
    scope: taskId === undefined ? "overall" : "task",
    ...(taskId === undefined ? {} : { taskId }),
    variantA,
    variantB,
    trialsA: trialsA.length,
    trialsB: trialsB.length,
    matchedTrials: matchedTrials(trialsA, trialsB),
    metrics,
  });
}

/**
 * Compares two reports using Fisher's exact test and independent seeded bootstraps.
 *
 * Matching task/trial indexes with equal recorded seeds are counted as matched for
 * context only; all statistical tests remain independent-sample tests.
 *
 * @param inputA - Report for variant A.
 * @param inputB - Report for variant B.
 * @param inputOptions - Optional variant selectors and bootstrap seed.
 * @returns Task comparisons followed by an overall comparison.
 */
export function compareEvalReports(
  inputA: unknown,
  inputB: unknown,
  inputOptions: ComparisonOptions = {},
): EvalComparisonReport {
  const reportA = EvalReportSchema.parse(inputA);
  const reportB = EvalReportSchema.parse(inputB);
  const options = ComparisonOptionsSchema.parse(inputOptions);
  const variantA = selectVariant(reportA, options.variantA);
  const variantB = selectVariant(reportB, options.variantB);
  const tasks = taskIds(reportA, reportB);
  const taskComparisons = tasks.map((taskId) =>
    compareGroup({ reportA, reportB, variantA, variantB, options, taskId }),
  );
  const rawPassPValues = taskComparisons.map(
    (comparison) => comparison.metrics.find(({ metric }) => metric === "pass_rate")?.pValue ?? 1,
  );
  const adjustedPassPValues = holmBonferroni(rawPassPValues);
  const correctedTaskComparisons = taskComparisons.map((comparison, index) => {
    const rawPass = comparison.metrics.find(({ metric }) => metric === "pass_rate");
    const adjustedPValue = adjustedPassPValues[index] ?? 1;
    const correctedPass =
      rawPass === undefined
        ? undefined
        : withVerdict(
            EvalComparisonMetricSchema.parse({ ...rawPass, adjustedPValue }),
            selectedTrials(reportA, variantA, comparison.taskId),
            selectedTrials(reportB, variantB, comparison.taskId),
          );
    return EvalComparisonSchema.parse({
      ...comparison,
      metrics: comparison.metrics.map((metric) =>
        metric.metric === "pass_rate" && correctedPass !== undefined ? correctedPass : metric,
      ),
    });
  });
  const overall = compareGroup({ reportA, reportB, variantA, variantB, options });
  return EvalComparisonReportSchema.parse({
    schemaVersion: 1,
    comparisons: [...correctedTaskComparisons, overall],
  });
}

function formatNumber(value: number): string {
  return value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatPValue(value: number | null): string {
  return value === null ? "—" : formatNumber(value);
}

/** Renders the comparison report as a metadata-only table. */
export function renderComparisonTable(input: unknown): string {
  const report = EvalComparisonReportSchema.parse(input);
  const firstComparison = report.comparisons[0];
  const lines = [
    ...(firstComparison === undefined
      ? []
      : [`A: ${firstComparison.variantA}\tB: ${firstComparison.variantB}`]),
    "Task\tMetric\tA\tB\tDelta\t95% CI\tRaw p\tAdjusted p\tEffect size\tVerdict",
  ];
  for (const comparison of report.comparisons) {
    const scope = comparison.taskId ?? "overall";
    for (const metric of comparison.metrics) {
      const interval =
        metric.confidenceInterval === null
          ? "—"
          : `${formatNumber(metric.confidenceInterval.low)} to ${formatNumber(metric.confidenceInterval.high)}`;
      const scale = metric.metric === "pass_rate" ? 100 : 1;
      const unit = metric.metric === "pass_rate" ? "%" : "";
      lines.push(
        [
          scope,
          metric.metric,
          `${formatNumber(metric.a * scale)}${unit}`,
          `${formatNumber(metric.b * scale)}${unit}`,
          `${formatNumber(metric.delta * scale)}${unit}`,
          interval,
          formatPValue(metric.pValue),
          formatPValue(metric.adjustedPValue),
          formatNumber(metric.effectSize * scale),
          metric.verdict,
        ].join("\t"),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
