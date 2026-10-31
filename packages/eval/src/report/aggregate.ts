// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { EvalTrialMetricsSchema } from "./schema.js";
import type { EvalAggregate, EvalTrialMetrics } from "./schema.js";

const SampleSchema = z.array(z.number().nonnegative()).min(1);

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** Unbiased pass@k estimator for a sample with `n` trials and `c` passes. */
export function passAtK(n: number, c: number, k: number): number {
  const parsed = z
    .object({
      n: z.number().int().nonnegative(),
      c: z.number().int().nonnegative(),
      k: z.number().int().positive(),
    })
    .refine(({ n: count, c: passes }) => passes <= count)
    .parse({ n, c, k });
  if (parsed.n - parsed.c < parsed.k) {
    return 1;
  }

  let noPassProbability = 1;
  for (let index = 0; index < parsed.k; index += 1) {
    noPassProbability *= (parsed.n - parsed.c - index) / (parsed.n - index);
  }
  return Math.min(1, Math.max(0, 1 - noPassProbability));
}

/** Mean, averaged middle-pair median, and nearest-rank p95 for a non-empty numeric sample. */
export function summarize(values: readonly number[]): {
  mean: number;
  median: number;
  p95: number;
} {
  const sample = SampleSchema.parse(values);
  const sorted = [...sample].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return {
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    median,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
  };
}

/** Aggregates metadata-only trial metrics by task and variant in stable order. */
export function aggregateEvalMetrics(input: readonly EvalTrialMetrics[]): EvalAggregate[] {
  const trials = EvalTrialMetricsSchema.array().parse(input);
  const groups = new Map<string, [EvalTrialMetrics, ...EvalTrialMetrics[]]>();
  for (const trial of trials) {
    const key = `${trial.taskId}\u0000${trial.variantId}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [trial]);
    } else {
      group.push(trial);
    }
  }

  const aggregates: EvalAggregate[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const n = group.length;
    const passes = group.filter(({ passed }) => passed).length;
    const passRate = passes / n;
    aggregates.push({
      taskId: first.taskId,
      variantId: first.variantId,
      n,
      passes,
      passRate,
      standardError: Math.sqrt((passRate * (1 - passRate)) / n),
      passAtK: Array.from({ length: n }, (_, index) => ({
        k: index + 1,
        rate: passAtK(n, passes, index + 1),
      })),
      costMicros: summarize(group.map(({ costMicros }) => costMicros)),
      inputTokens: summarize(group.map(({ inputTokens }) => inputTokens)),
      outputTokens: summarize(group.map(({ outputTokens }) => outputTokens)),
      totalTokens: summarize(
        group.map(({ inputTokens, outputTokens }) => inputTokens + outputTokens),
      ),
      steps: summarize(group.map(({ steps }) => steps)),
      latencyMs: summarize(group.map(({ wallTimeMs }) => wallTimeMs)),
    });
  }

  return aggregates.sort((left, right) => {
    const taskOrder = compareText(left.taskId, right.taskId);
    return taskOrder !== 0 ? taskOrder : compareText(left.variantId, right.variantId);
  });
}
