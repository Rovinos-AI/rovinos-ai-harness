// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const BenchmarkMetricNameSchema = z.string().regex(/^[a-z][a-z0-9._-]+$/u);
const BenchmarkUnitSchema = z.enum(["ops/s", "events/s", "ms", "MiB/s", "bytes"]);

export const BenchmarkResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    environment: z
      .object({
        runner: z.string().min(1),
        platform: z.string().min(1),
        architecture: z.string().min(1),
        cpu: z.string().min(1),
        cpuCount: z.number().int().positive(),
        memoryBytes: z.number().int().positive(),
        node: z.string().min(1),
      })
      .strict(),
    sample: z
      .object({
        profile: z.enum(["smoke", "nightly"]),
        durationMs: z.number().int().positive(),
        warmupMs: z.number().int().nonnegative(),
      })
      .strict(),
    metrics: z
      .array(
        z
          .object({
            name: BenchmarkMetricNameSchema,
            value: z.number().nonnegative(),
            unit: BenchmarkUnitSchema,
            sampleCount: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .superRefine((metrics, context) => {
        const names = new Set<string>();
        metrics.forEach(({ name }, index) => {
          if (names.has(name)) {
            context.addIssue({
              code: "custom",
              path: [index, "name"],
              message: "duplicate_metric",
            });
          }
          names.add(name);
        });
      }),
  })
  .strict();

/** A validated aggregate benchmark result and its environment description. */
export type BenchmarkResult = z.infer<typeof BenchmarkResultSchema>;

/** Absolute performance limit for one benchmark metric. */
const AbsoluteBudgetSchema = z
  .object({
    metric: BenchmarkMetricNameSchema,
    direction: z.enum(["max", "min"]),
    limit: z.number().nonnegative(),
    unit: BenchmarkUnitSchema,
  })
  .strict();

const RelativeBudgetSchema = z
  .object({
    metric: BenchmarkMetricNameSchema,
    direction: z.enum(["max", "min"]),
    maxRegression: z.number().min(0).max(1),
    unit: BenchmarkUnitSchema,
  })
  .strict();

export const BenchmarkBudgetsSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: z
      .object({
        runner: z.string().min(1),
        description: z.string().min(1),
      })
      .strict(),
    sample: z
      .object({
        profile: z.literal("nightly"),
        durationMs: z.number().int().positive(),
        warmupMs: z.number().int().nonnegative(),
        minimumSamples: z.number().int().positive(),
        note: z.string().min(1),
      })
      .strict(),
    absolute: z.array(AbsoluteBudgetSchema).min(1),
    relative: z.array(RelativeBudgetSchema).min(1),
  })
  .strict();

/** A validated budget configuration for nightly measurements. */
export type BenchmarkBudgets = z.infer<typeof BenchmarkBudgetsSchema>;

/** A single failed absolute or relative performance check. */
export interface BudgetViolation {
  readonly metric: string;
  readonly code:
    | "absolute_exceeded"
    | "relative_regression"
    | "result_missing"
    | "baseline_missing"
    | "unit_mismatch"
    | "sample_count_low"
    | "environment_mismatch"
    | "sample_mismatch";
  readonly actual?: number;
  readonly limit?: number;
  readonly unit?: string;
}

interface EvaluationContext {
  readonly currentMetrics: ReadonlyMap<string, BenchmarkResult["metrics"][number]>;
  readonly baselineMetrics: ReadonlyMap<string, BenchmarkResult["metrics"][number]>;
  readonly environmentMatches: boolean;
  readonly sampleMatches: boolean;
  readonly minimumSamples: number;
  readonly allowMissingBaseline: boolean;
}

function sampleMatches(result: BenchmarkResult, budgets: BenchmarkBudgets): boolean {
  return (
    result.sample.profile === budgets.sample.profile &&
    result.sample.durationMs === budgets.sample.durationMs &&
    result.sample.warmupMs === budgets.sample.warmupMs
  );
}

function checkAbsoluteBudget(
  budget: BenchmarkBudgets["absolute"][number],
  context: EvaluationContext,
): BudgetViolation[] {
  const metric = context.currentMetrics.get(budget.metric);
  if (metric === undefined) {
    return [{ metric: budget.metric, code: "result_missing" }];
  }
  if (metric.unit !== budget.unit) {
    return [{ metric: budget.metric, code: "unit_mismatch", unit: metric.unit }];
  }
  const violations: BudgetViolation[] = [];
  if (metric.sampleCount < context.minimumSamples) {
    violations.push({
      metric: budget.metric,
      code: "sample_count_low",
      actual: metric.sampleCount,
      limit: context.minimumSamples,
      unit: "samples",
    });
  }
  const exceeded =
    budget.direction === "max" ? metric.value > budget.limit : metric.value < budget.limit;
  if (exceeded) {
    violations.push({
      metric: budget.metric,
      code: "absolute_exceeded",
      actual: metric.value,
      limit: budget.limit,
      unit: budget.unit,
    });
  }
  return violations;
}

function checkRelativeBudget(
  budget: BenchmarkBudgets["relative"][number],
  context: EvaluationContext,
): BudgetViolation[] {
  const metric = context.currentMetrics.get(budget.metric);
  const baselineMetric = context.baselineMetrics.get(budget.metric);
  if (metric === undefined) {
    return [{ metric: budget.metric, code: "result_missing" }];
  }
  if (
    metric.unit !== budget.unit ||
    (baselineMetric !== undefined && baselineMetric.unit !== budget.unit)
  ) {
    return [{ metric: budget.metric, code: "unit_mismatch", unit: metric.unit }];
  }
  if (context.baselineMetrics.size === 0) {
    return context.allowMissingBaseline
      ? []
      : [{ metric: budget.metric, code: "baseline_missing" }];
  }
  if (!context.environmentMatches || !context.sampleMatches) {
    return [];
  }
  if (baselineMetric === undefined) {
    return [{ metric: budget.metric, code: "baseline_missing" }];
  }
  const limit =
    budget.direction === "max"
      ? baselineMetric.value * (1 + budget.maxRegression)
      : baselineMetric.value * (1 - budget.maxRegression);
  const regressed = budget.direction === "max" ? metric.value > limit : metric.value < limit;
  return regressed
    ? [
        {
          metric: budget.metric,
          code: "relative_regression",
          actual: metric.value,
          limit,
          unit: budget.unit,
        },
      ]
    : [];
}

/** Evaluates absolute limits, metadata compatibility, and relative regressions. */
export function evaluateBudgets(
  budgets: BenchmarkBudgets,
  current: BenchmarkResult,
  baseline?: BenchmarkResult,
  allowMissingBaseline = false,
): BudgetViolation[] {
  const environmentMatches =
    current.environment.runner === budgets.environment.runner &&
    (baseline === undefined || baseline.environment.runner === budgets.environment.runner);
  const samplesMatch =
    sampleMatches(current, budgets) && (baseline === undefined || sampleMatches(baseline, budgets));
  const context: EvaluationContext = {
    currentMetrics: new Map(current.metrics.map((metric) => [metric.name, metric])),
    baselineMetrics: new Map(baseline?.metrics.map((metric) => [metric.name, metric]) ?? []),
    environmentMatches,
    sampleMatches: samplesMatch,
    minimumSamples: budgets.sample.minimumSamples,
    allowMissingBaseline,
  };
  const violations: BudgetViolation[] = [];
  if (!environmentMatches) {
    violations.push({ metric: "environment.runner", code: "environment_mismatch" });
  }
  if (!samplesMatch) {
    violations.push({ metric: "sample.configuration", code: "sample_mismatch" });
  }
  for (const budget of budgets.absolute) {
    violations.push(...checkAbsoluteBudget(budget, context));
  }
  for (const budget of budgets.relative) {
    violations.push(...checkRelativeBudget(budget, context));
  }
  return violations;
}
