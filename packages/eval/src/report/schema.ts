// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import { z } from "zod";
import { ApprovalCountsSchema, EvalTrialRecordSchema } from "../trial.js";
import { GradeResultSchema } from "../graders/types.js";

const TrialIdentitySchema = z
  .object({
    taskId: Code,
    variantId: Code,
    trialIndex: z.number().int().nonnegative(),
  })
  .strict();

/** Grade results associated with one trial; only pass decisions and codes enter the report. */
export const EvalGradeRecordSchema = TrialIdentitySchema.extend({
  graders: z.array(GradeResultSchema),
}).strict();

/** Inferred grade results associated with one task/variant/trial. */
export type EvalGradeRecord = z.infer<typeof EvalGradeRecordSchema>;

/** Validated source records needed to build an evaluation report. */
export const EvalReportInputSchema = z
  .object({
    invariantsEnabled: z.boolean().default(true),
    trials: z.array(EvalTrialRecordSchema),
    grades: z.array(EvalGradeRecordSchema),
  })
  .strict()
  .superRefine(({ trials, grades }, context) => {
    const trialKeys = new Set<string>();
    for (const [index, trial] of trials.entries()) {
      const key = `${trial.taskId}\u0000${trial.variantId}\u0000${String(trial.trialIndex)}`;
      if (trialKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["trials", index],
          message: "Trial identities must be unique.",
          params: { errorCode: "eval_trial_duplicate" },
        });
      }
      trialKeys.add(key);
    }

    const gradeKeys = new Set<string>();
    for (const [index, grade] of grades.entries()) {
      const key = `${grade.taskId}\u0000${grade.variantId}\u0000${String(grade.trialIndex)}`;
      if (gradeKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["grades", index],
          message: "Grade identities must be unique.",
          params: { errorCode: "eval_grade_duplicate" },
        });
      } else if (!trialKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["grades", index],
          message: "Every grade must match a trial identity.",
          params: { errorCode: "eval_grade_trial_missing" },
        });
      }
      gradeKeys.add(key);
    }

    for (const [index, trial] of trials.entries()) {
      const key = `${trial.taskId}\u0000${trial.variantId}\u0000${String(trial.trialIndex)}`;
      if (!gradeKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["trials", index],
          message: "Every trial requires a grade record, including trials with no graders.",
          params: { errorCode: "eval_grade_record_missing" },
        });
      }
    }
  });

/** Metadata-only metrics for one trial. */
export const EvalTrialMetricsSchema = z
  .object({
    taskId: Code,
    variantId: Code,
    trialIndex: z.number().int().nonnegative(),
    seed: z.number().int().nonnegative().max(0xffff_ffff).optional(),
    status: z.enum(["completed", "failed", "suspended", "cancelled", "error", "skipped_budget"]),
    passed: z.boolean(),
    graders: z
      .array(
        z
          .object({
            graderId: Code,
            pass: z.boolean(),
            codes: z.array(Code),
          })
          .strict(),
      )
      .readonly(),
    steps: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
    wallTimeMs: z.number().int().nonnegative(),
    repairAttempts: z.number().int().nonnegative(),
    fallbackDepth: z.number().int().nonnegative(),
    approvals: ApprovalCountsSchema,
    deniedToolCalls: z.number().int().nonnegative(),
    budgetExceeded: z.boolean(),
    unsafeAutoApprove: z.boolean(),
  })
  .strict();

/** Inferred metadata-only metrics for one trial. */
export type EvalTrialMetrics = z.infer<typeof EvalTrialMetricsSchema>;

/** One mean/median/nearest-rank p95 summary. */
export const MetricSummarySchema = z
  .object({
    mean: z.number().nonnegative(),
    median: z.number().nonnegative(),
    p95: z.number().nonnegative(),
  })
  .strict();

/** Inferred summary statistics for one numeric metric. */
export type MetricSummary = z.infer<typeof MetricSummarySchema>;

/** pass@k point for one sample size. */
export const PassAtKSchema = z
  .object({
    k: z.number().int().positive(),
    rate: z.number().min(0).max(1),
  })
  .strict();

/** Inferred pass@k point. */
export type PassAtK = z.infer<typeof PassAtKSchema>;

/** Aggregated metrics for one task/variant pair. */
export const EvalAggregateSchema = z
  .object({
    taskId: Code,
    variantId: Code,
    n: z.number().int().nonnegative(),
    passes: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1),
    standardError: z.number().nonnegative(),
    passAtK: z.array(PassAtKSchema),
    costMicros: MetricSummarySchema,
    inputTokens: MetricSummarySchema,
    outputTokens: MetricSummarySchema,
    totalTokens: MetricSummarySchema,
    steps: MetricSummarySchema,
    latencyMs: MetricSummarySchema,
  })
  .strict()
  .superRefine((aggregate, context) => {
    if (aggregate.passes > aggregate.n) {
      context.addIssue({
        code: "custom",
        path: ["passes"],
        message: "Passes cannot exceed trials.",
        params: { errorCode: "eval_pass_count_invalid" },
      });
    }
  });

/** Inferred aggregate for one task/variant pair. */
export type EvalAggregate = z.infer<typeof EvalAggregateSchema>;

/** Versioned, content-free evaluation report contract. */
export const EvalReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    invariantsEnabled: z.boolean().default(false),
    trials: z.array(EvalTrialMetricsSchema),
    aggregates: z.array(EvalAggregateSchema),
  })
  .strict();

/** Inferred versioned evaluation report. */
export type EvalReport = z.infer<typeof EvalReportSchema>;
