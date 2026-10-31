// SPDX-License-Identifier: Apache-2.0
import { EvalReportInputSchema, EvalReportSchema } from "./schema.js";
import type { EvalReport } from "./schema.js";
import { aggregateEvalMetrics } from "./aggregate.js";
import { computeTrialMetrics } from "./metrics.js";

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareTrial(
  left: EvalReport["trials"][number],
  right: EvalReport["trials"][number],
): number {
  const taskOrder = compareText(left.taskId, right.taskId);
  if (taskOrder !== 0) {
    return taskOrder;
  }
  const variantOrder = compareText(left.variantId, right.variantId);
  return variantOrder !== 0 ? variantOrder : left.trialIndex - right.trialIndex;
}

function compareAggregate(
  left: EvalReport["aggregates"][number],
  right: EvalReport["aggregates"][number],
): number {
  const taskOrder = compareText(left.taskId, right.taskId);
  return taskOrder !== 0 ? taskOrder : compareText(left.variantId, right.variantId);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, sortKeys(child)]),
  );
}

/** Builds validated per-trial metrics and task/variant aggregates from trial and grade records. */
export function buildEvalReport(input: unknown): EvalReport {
  const parsed = EvalReportInputSchema.parse(input);
  const gradeByIdentity = new Map(
    parsed.grades.map((grade) => [
      `${grade.taskId}\u0000${grade.variantId}\u0000${String(grade.trialIndex)}`,
      grade.graders,
    ]),
  );
  const trials = parsed.trials
    .map((trial) => {
      const key = `${trial.taskId}\u0000${trial.variantId}\u0000${String(trial.trialIndex)}`;
      return computeTrialMetrics(trial, gradeByIdentity.get(key) ?? []);
    })
    .sort(compareTrial);
  return EvalReportSchema.parse({
    schemaVersion: 1,
    trials,
    aggregates: aggregateEvalMetrics(trials),
  });
}

/** Serializes a validated report with recursively sorted keys and a trailing newline. */
export function serializeEvalReport(report: unknown): string {
  const parsed = EvalReportSchema.parse(report);
  const stable = {
    ...parsed,
    trials: [...parsed.trials].sort(compareTrial),
    aggregates: [...parsed.aggregates].sort(compareAggregate),
  };
  return `${JSON.stringify(sortKeys(stable), null, 2)}\n`;
}
