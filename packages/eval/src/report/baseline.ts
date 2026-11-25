// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code } from "@rovinos/schemas";
import { EvalAggregateSchema, EvalReportSchema } from "./schema.js";
import type { EvalReport } from "./schema.js";

const PrivacyAssertionSchema = z
  .object({
    taskId: Code,
    variantId: Code,
    trialIndex: z.number().int().nonnegative(),
    graderId: z.enum(["no_canary_leak", "trajectory"]),
  })
  .strict();

/** Metadata-only evaluation baseline. */
export const EvalBaselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    aggregates: z.array(EvalAggregateSchema),
    passingPrivacyAssertions: z.array(PrivacyAssertionSchema),
  })
  .strict();

/** Inferred metadata-only evaluation baseline. */
export type EvalBaseline = z.infer<typeof EvalBaselineSchema>;

const RegressionSchema = z
  .object({
    code: z.enum(["pass_rate_drop", "task_removed", "privacy_assertion_failed"]),
    taskId: Code,
    variantId: Code,
    graderId: z.enum(["no_canary_leak", "trajectory"]).optional(),
    baselinePassRate: z.number().min(0).max(1).optional(),
    currentPassRate: z.number().min(0).max(1).optional(),
  })
  .strict();

/** One safe, metadata-only regression description. */
export type EvalBaselineRegression = z.infer<typeof RegressionSchema>;

/** Result of checking a report against an accepted evaluation baseline. */
export const EvalBaselineCheckSchema = z
  .object({ passed: z.boolean(), regressions: z.array(RegressionSchema) })
  .strict();

/** Inferred baseline check result. */
export type EvalBaselineCheck = z.infer<typeof EvalBaselineCheckSchema>;

/** Result emitted after explicitly updating a baseline. */
export const EvalBaselineUpdateSchema = z.object({ updated: z.literal(true) }).strict();

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function pairKey(item: { readonly taskId: string; readonly variantId: string }): string {
  return `${item.taskId}\u0000${item.variantId}`;
}

function comparePairs(
  left: { readonly taskId: string; readonly variantId: string },
  right: { readonly taskId: string; readonly variantId: string },
): number {
  const taskOrder = compareText(left.taskId, right.taskId);
  if (taskOrder !== 0) {
    return taskOrder;
  }
  return compareText(left.variantId, right.variantId);
}

function assertionKey(item: z.infer<typeof PrivacyAssertionSchema>): string {
  return `${pairKey(item)}\u0000${String(item.trialIndex)}\u0000${item.graderId}`;
}

function compareAssertions(
  left: z.infer<typeof PrivacyAssertionSchema>,
  right: z.infer<typeof PrivacyAssertionSchema>,
): number {
  const pairOrder = comparePairs(left, right);
  if (pairOrder !== 0) {
    return pairOrder;
  }
  const trialOrder = left.trialIndex - right.trialIndex;
  if (trialOrder !== 0) {
    return trialOrder;
  }
  return compareText(left.graderId, right.graderId);
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

/** Builds an aggregate-only baseline with previously passing privacy outcomes. */
export function buildEvalBaseline(input: unknown): EvalBaseline {
  const report: EvalReport = EvalReportSchema.parse(input);
  const passingPrivacyAssertions = report.trials.flatMap((trial) =>
    trial.graders
      .filter(
        (
          grader,
        ): grader is typeof grader & {
          readonly graderId: "no_canary_leak" | "trajectory";
        } =>
          grader.pass && (grader.graderId === "no_canary_leak" || grader.graderId === "trajectory"),
      )
      .map(({ graderId }) => ({
        taskId: trial.taskId,
        variantId: trial.variantId,
        trialIndex: trial.trialIndex,
        graderId,
      })),
  );
  return EvalBaselineSchema.parse({
    schemaVersion: 1,
    aggregates: report.aggregates,
    passingPrivacyAssertions: passingPrivacyAssertions.sort(compareAssertions),
  });
}

/** Serializes a validated baseline in stable key and array order. */
export function serializeEvalBaseline(input: unknown): string {
  const baseline = EvalBaselineSchema.parse(input);
  const aggregates = [...baseline.aggregates].sort(comparePairs);
  const stable = EvalBaselineSchema.parse({
    ...baseline,
    aggregates,
    passingPrivacyAssertions: [...baseline.passingPrivacyAssertions].sort(compareAssertions),
  });
  return `${JSON.stringify(sortKeys(stable), null, 2)}\n`;
}

/** Checks a report against an accepted baseline; new task/variant pairs are allowed. */
export function checkEvalBaseline(
  baselineInput: unknown,
  reportInput: unknown,
  maxDrop: number,
): EvalBaselineCheck {
  const baseline = EvalBaselineSchema.parse(baselineInput);
  const report = EvalReportSchema.parse(reportInput);
  const threshold = z.number().min(0).max(1).parse(maxDrop);
  const currentAggregates = new Map(report.aggregates.map((item) => [pairKey(item), item]));
  const currentPrivacy = new Map<string, boolean>();
  for (const trial of report.trials) {
    for (const grader of trial.graders) {
      if (grader.graderId === "no_canary_leak" || grader.graderId === "trajectory") {
        currentPrivacy.set(
          assertionKey({
            taskId: trial.taskId,
            variantId: trial.variantId,
            trialIndex: trial.trialIndex,
            graderId: grader.graderId,
          }),
          grader.pass,
        );
      }
    }
  }

  const regressions: EvalBaselineRegression[] = [];
  for (const aggregate of baseline.aggregates) {
    const current = currentAggregates.get(pairKey(aggregate));
    if (current === undefined) {
      regressions.push({
        code: "task_removed",
        taskId: aggregate.taskId,
        variantId: aggregate.variantId,
      });
    } else if (aggregate.passRate - current.passRate > threshold) {
      regressions.push({
        code: "pass_rate_drop",
        taskId: aggregate.taskId,
        variantId: aggregate.variantId,
        baselinePassRate: aggregate.passRate,
        currentPassRate: current.passRate,
      });
    }
  }
  for (const assertion of baseline.passingPrivacyAssertions) {
    if (
      currentAggregates.has(pairKey(assertion)) &&
      currentPrivacy.get(assertionKey(assertion)) !== true
    ) {
      regressions.push({
        code: "privacy_assertion_failed",
        taskId: assertion.taskId,
        variantId: assertion.variantId,
        graderId: assertion.graderId,
      });
    }
  }
  return EvalBaselineCheckSchema.parse({ passed: regressions.length === 0, regressions });
}
