// SPDX-License-Identifier: Apache-2.0
import type { RunConfig } from "@harness/schemas";
import type { RunState } from "./run-state.js";

/** Budget dimensions checked before a model or tool operation. */
export type BudgetKind = "steps" | "cost" | "wall_clock";

/** A budget violation and the observed usage that exceeded its limit. */
export interface BudgetViolation {
  readonly ok: false;
  readonly budget: BudgetKind;
  readonly limit: number;
  readonly observed: number;
}

/** Result of checking the configured budgets against folded run state. */
export type BudgetCheck = { readonly ok: true } | BudgetViolation;

/**
 * Checks run usage against immutable limits. Equality is allowed for every limit.
 */
export class BudgetTracker {
  /**
   * Creates a tracker for one run's configured budgets.
   *
   * @param budgets - Validated budgets from the run configuration.
   */
  constructor(private readonly budgets: RunConfig["budgets"]) {}

  /**
   * Returns the first exceeded budget without changing the state or tracker.
   *
   * @param state - State folded from the run's complete event log.
   * @param now - Current epoch time in milliseconds.
   * @returns Whether usage is within every configured budget.
   */
  check(state: RunState, now: number): BudgetCheck {
    if (state.steps > this.budgets.maxSteps) {
      return {
        ok: false,
        budget: "steps",
        limit: this.budgets.maxSteps,
        observed: state.steps,
      };
    }

    if (this.budgets.maxCostUsd !== undefined) {
      const limit = this.budgets.maxCostUsd * 1_000_000;
      if (state.usage.costMicros > limit) {
        return { ok: false, budget: "cost", limit, observed: state.usage.costMicros };
      }
    }

    const ongoingSuspension =
      state.suspendedAt === undefined ? 0 : Math.max(0, now - state.suspendedAt);
    const suspendedTime = this.budgets.countSuspendedTime
      ? 0
      : state.suspendedTimeMs + ongoingSuspension;
    const elapsedMs = Math.max(0, now - state.startedAt - suspendedTime);
    if (elapsedMs > this.budgets.maxWallClockMs) {
      return {
        ok: false,
        budget: "wall_clock",
        limit: this.budgets.maxWallClockMs,
        observed: elapsedMs,
      };
    }

    return { ok: true };
  }
}
