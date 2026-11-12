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
            value: z.number().finite().nonnegative(),
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
            context.addIssue({ code: "custom", path: [index, "name"], message: "duplicate_metric" });
          }
          names.add(name);
        });
      }),
  })
  .strict();

export type BenchmarkResult = z.infer<typeof BenchmarkResultSchema>;

const AbsoluteBudgetSchema = z
  .object({
    metric: BenchmarkMetricNameSchema,
    direction: z.enum(["max", "min"]),
    limit: z.number().finite().nonnegative(),
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

export type BenchmarkBudgets = z.infer<typeof BenchmarkBudgetsSchema>;

export interface BudgetViolation {
  readonly metric: string;
  readonly code:
    | "absolute_exceeded"
    | "relative_regression"
    | "result_missing"
    | "baseline_missing"
    | "unit_mismatch";
  readonly actual?: number;
  readonly limit?: number;
  readonly unit?: string;
}

export function evaluateBudgets(
  budgets: BenchmarkBudgets,
  current: BenchmarkResult,
  baseline?: BenchmarkResult,
  allowMissingBaseline = false,
): BudgetViolation[] {
  const currentMetrics = new Map(current.metrics.map((metric) => [metric.name, metric]));
  const baselineMetrics = new Map(baseline?.metrics.map((metric) => [metric.name, metric]) ?? []);
  const violations: BudgetViolation[] = [];

  for (const budget of budgets.absolute) {
    const metric = currentMetrics.get(budget.metric);
    if (metric === undefined) {
      violations.push({ metric: budget.metric, code: "result_missing" });
    } else if (metric.unit !== budget.unit) {
      violations.push({ metric: budget.metric, code: "unit_mismatch", unit: metric.unit });
    } else if (
      budget.direction === "max"
        ? metric.value > budget.limit
        : metric.value < budget.limit
    ) {
      violations.push({
        metric: budget.metric,
        code: "absolute_exceeded",
        actual: metric.value,
        limit: budget.limit,
        unit: budget.unit,
      });
    }
  }

  for (const budget of budgets.relative) {
    const metric = currentMetrics.get(budget.metric);
    const baselineMetric = baselineMetrics.get(budget.metric);
    if (metric === undefined) {
      violations.push({ metric: budget.metric, code: "result_missing" });
      continue;
    }
    if (metric.unit !== budget.unit || (baselineMetric !== undefined && baselineMetric.unit !== budget.unit)) {
      violations.push({ metric: budget.metric, code: "unit_mismatch", unit: metric.unit });
      continue;
    }
    if (baseline === undefined) {
      if (!allowMissingBaseline) {
        violations.push({ metric: budget.metric, code: "baseline_missing" });
      }
      continue;
    }
    if (baselineMetric === undefined) {
      violations.push({ metric: budget.metric, code: "baseline_missing" });
      continue;
    }
    const regressed =
      budget.direction === "max"
        ? metric.value > baselineMetric.value * (1 + budget.maxRegression)
        : metric.value < baselineMetric.value * (1 - budget.maxRegression);
    if (regressed) {
      violations.push({
        metric: budget.metric,
        code: "relative_regression",
        actual: metric.value,
        limit:
          budget.direction === "max"
            ? baselineMetric.value * (1 + budget.maxRegression)
            : baselineMetric.value * (1 - budget.maxRegression),
        unit: budget.unit,
      });
    }
  }

  return violations;
}
