// SPDX-License-Identifier: Apache-2.0
// Optional child step totals preserve old logs while keeping inherited budgets cumulative.
import { HarnessError, type RunConfig, type RoleBudgets } from "@harness/schemas";
import { BudgetTracker } from "../budgets.js";
import type { RunState } from "../run-state.js";

/** A child cannot start when its parent has exhausted a required budget. */
export class ChildBudgetExceededError extends HarnessError {
  override readonly code = "budget_exceeded";

  constructor() {
    super("The parent has no remaining budget for a child run.");
  }
}

/**
 * Derives child limits from the parent's remaining allowance and the selected role's limits.
 *
 * @param parentState - Folded parent state, including completed child usage.
 * @param parentBudgets - Validated budgets for the parent run.
 * @param roleBudgets - Optional tighter limits configured for the selected role.
 * @param now - Current epoch time in milliseconds.
 * @returns Child limits that are no larger than either applicable limit.
 * @throws ChildBudgetExceededError when a required parent budget is exhausted.
 */
export function deriveChildBudgets(
  parentState: RunState,
  parentBudgets: RunConfig["budgets"],
  roleBudgets: RoleBudgets | undefined,
  now: number,
): RunConfig["budgets"] {
  const parentRemainingSteps = parentBudgets.maxSteps - parentState.steps;
  if (parentRemainingSteps < 1) {
    throw new ChildBudgetExceededError();
  }

  const maxSteps = Math.min(
    roleBudgets?.maxSteps ?? Number.POSITIVE_INFINITY,
    parentRemainingSteps,
  );
  let maxCostUsd: number | undefined;
  if (parentBudgets.maxCostUsd !== undefined) {
    const parentRemainingCost =
      Math.floor(parentBudgets.maxCostUsd * 1_000_000 - parentState.usage.costMicros) / 1_000_000;
    if (parentRemainingCost <= 0) {
      throw new ChildBudgetExceededError();
    }
    maxCostUsd = Math.min(roleBudgets?.maxCostUsd ?? Number.POSITIVE_INFINITY, parentRemainingCost);
  } else if (roleBudgets?.maxCostUsd !== undefined) {
    maxCostUsd = roleBudgets.maxCostUsd;
  }

  const parentDeadline = new BudgetTracker(parentBudgets).deadlineTs(parentState);
  const roleDeadline =
    roleBudgets?.maxWallClockMs === undefined
      ? Number.POSITIVE_INFINITY
      : now + roleBudgets.maxWallClockMs;
  const deadline = Math.min(parentDeadline, roleDeadline);
  const maxWallClockMs = Math.floor(deadline - now);
  if (maxWallClockMs < 1) {
    throw new ChildBudgetExceededError();
  }

  return {
    ...parentBudgets,
    maxSteps,
    maxWallClockMs,
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
  };
}
