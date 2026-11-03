// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";
import { parseJson } from "@rovinos/schemas";
import { GradeResultSchema } from "../graders/types.js";
import type { GradeResult } from "../graders/types.js";
import { EvalTrialRecordSchema, TrialExecutionMetricsSchema } from "../trial.js";
import type { EvalTrialRecord, TrialExecutionMetrics } from "../trial.js";
import { EvalTrialMetricsSchema } from "./schema.js";
import type { EvalTrialMetrics } from "./schema.js";

/**
 * Derives bounded counters from the event log; repairs are summed and fallback depth is the maximum.
 */
export function executionMetricsFromEvents(
  events: readonly Event[],
  steps: number,
): TrialExecutionMetrics {
  const responses = events.filter((event) => event.type === "model_response");
  return TrialExecutionMetricsSchema.parse({
    steps,
    repairAttempts: responses.reduce((count, event) => count + event.repairAttempts, 0),
    fallbackDepth: responses.reduce((depth, event) => Math.max(depth, event.fallbackDepth), 0),
    deniedToolCalls: events.filter(
      (event) => event.type === "tool_result" && event.outcome === "denied",
    ).length,
    budgetExceeded: events.some((event) => event.type === "budget_exceeded"),
  });
}

/** Computes metadata-only report metrics for one validated trial record and its grades. */
export function computeTrialMetrics(
  inputRecord: EvalTrialRecord,
  inputGrades: readonly GradeResult[],
): EvalTrialMetrics {
  const record = EvalTrialRecordSchema.parse(inputRecord);
  const grades = GradeResultSchema.array().parse(inputGrades);
  const gradeMetrics = grades.map(({ graderId, pass, codes }) => ({
    graderId,
    pass,
    codes: [...new Set(codes)].sort(),
  }));
  if (record.result.status !== "completed") {
    gradeMetrics.push({
      graderId: "trial_status",
      pass: false,
      codes: [record.result.errorCode ?? `trial_${record.result.status}`],
    });
  }
  gradeMetrics.sort((left, right) => {
    if (left.graderId < right.graderId) {
      return -1;
    }
    if (left.graderId > right.graderId) {
      return 1;
    }
    return 0;
  });
  const inputTokens =
    record.result.usage.inputTokens +
    grades.reduce((total, grade) => total + (grade.usage?.inputTokens ?? 0), 0);
  const outputTokens =
    record.result.usage.outputTokens +
    grades.reduce((total, grade) => total + (grade.usage?.outputTokens ?? 0), 0);
  const costMicros =
    record.result.usage.costMicros +
    grades.reduce((total, grade) => total + (grade.usage?.costMicros ?? 0), 0);

  return EvalTrialMetricsSchema.parse({
    taskId: record.taskId,
    variantId: record.variantId,
    trialIndex: record.trialIndex,
    seed: record.seed,
    status: record.result.status,
    passed: record.result.status === "completed" && gradeMetrics.every((grade) => grade.pass),
    graders: gradeMetrics.map((grade) => ({
      ...grade,
      ...(!grade.pass && grade.codes.length === 0 ? { codes: ["grader_failed"] } : {}),
    })),
    steps: record.result.metrics.steps,
    inputTokens,
    outputTokens,
    costMicros,
    wallTimeMs: record.result.durationMs,
    repairAttempts: record.result.metrics.repairAttempts,
    fallbackDepth: record.result.metrics.fallbackDepth,
    approvals: record.result.approvals,
    inputs: record.result.inputs ?? { accepted: 0, declined: 0, cancelled: 0 },
    deniedToolCalls: record.result.metrics.deniedToolCalls,
    budgetExceeded: record.result.metrics.budgetExceeded,
    unsafeAutoApprove: record.result.unsafeAutoApprove,
  });
}

/** Parses non-empty lines of a trials.jsonl file with the versioned trial-record schema. */
export function parseEvalTrialJsonl(text: string): EvalTrialRecord[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseJson(EvalTrialRecordSchema, line));
}
