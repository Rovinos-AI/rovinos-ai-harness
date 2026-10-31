// SPDX-License-Identifier: Apache-2.0
import { EvalTrialRecordSchema } from "../src/trial.js";
import type { EvalTrialRecord, TrialResult } from "../src/trial.js";
import { GradeResultSchema } from "../src/graders/types.js";
import type { GradeResult } from "../src/graders/types.js";
import { completedTrialResult } from "./trial-result.js";

/** Builds a validated content-free trial record for report tests. */
export function reportTrial(
  overrides: {
    readonly taskId?: string;
    readonly variantId?: string;
    readonly trialIndex?: number;
    readonly result?: Partial<TrialResult>;
  } = {},
): EvalTrialRecord {
  return EvalTrialRecordSchema.parse({
    schemaVersion: 1,
    suiteCode: "eval_suite",
    taskId: overrides.taskId ?? "task_one",
    variantId: overrides.variantId ?? "baseline",
    trialIndex: overrides.trialIndex ?? 0,
    seed: 1,
    result: {
      ...completedTrialResult(),
      ...overrides.result,
      ...(overrides.result?.status === "error" && overrides.result.errorCode === undefined
        ? { errorCode: "synthetic_error" }
        : {}),
    },
  });
}

/** Builds a validated, metadata-only grader result for report tests. */
export function reportGrade(
  pass: boolean,
  codes: readonly string[] = [],
  graderId = "file_diff",
  usage?: GradeResult["usage"],
): GradeResult {
  return GradeResultSchema.parse({
    graderId,
    pass,
    score: pass ? 1 : 0,
    codes,
    ...(usage === undefined ? {} : { usage }),
  });
}
