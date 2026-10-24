// SPDX-License-Identifier: Apache-2.0
import type { Code, RunStatus as RunStatusType } from "@rovinos/schemas";

/** Triggers accepted by the run lifecycle state machine. */
export const RUN_TRIGGERS = [
  "start",
  "request_approval",
  "approval_resolved",
  "complete",
  "fail",
  "cancel",
  "shutdown",
  "resume",
] as const;

/** Inferred lifecycle trigger. */
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

const transitions: Record<RunStatusType, Partial<Record<RunTrigger, RunStatusType>>> = {
  pending: { start: "running", cancel: "cancelled" },
  running: {
    request_approval: "suspended",
    shutdown: "suspended",
    complete: "completed",
    fail: "failed",
    cancel: "cancelled",
  },
  suspended: {
    resume: "running",
    cancel: "cancelled",
    fail: "failed",
  },
  completed: {},
  failed: {},
  cancelled: {},
};

/** Result of applying a lifecycle trigger to a run status. */
export type TransitionResult =
  { readonly ok: true; readonly to: RunStatusType } | { readonly ok: false; readonly code: Code };

/**
 * Returns the next run status for a trigger, or the closed invalid-transition code.
 *
 * @param from - Current run status.
 * @param trigger - Lifecycle trigger to apply.
 * @returns The next status or an invalid-transition result.
 */
export function transition(from: RunStatusType, trigger: RunTrigger): TransitionResult {
  const to = transitions[from][trigger];
  return to === undefined ? { ok: false, code: "invalid_transition" } : { ok: true, to };
}

/**
 * Checks whether a lifecycle trigger is accepted for a run status.
 *
 * @param from - Current run status.
 * @param trigger - Lifecycle trigger to check.
 * @returns Whether the transition is allowed.
 */
export function canTransition(from: RunStatusType, trigger: RunTrigger): boolean {
  return transition(from, trigger).ok;
}
