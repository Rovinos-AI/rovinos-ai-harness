// SPDX-License-Identifier: Apache-2.0
import type { TrialResult } from "../src/trial.js";

/** Builds a completed trial result with defaults for newly added metadata fields. */
export function completedTrialResult(
  overrides: Omit<Partial<TrialResult>, "status"> = {},
): TrialResult {
  return {
    status: "completed",
    dbPath: "/synthetic/run.db",
    workspaceDir: "/synthetic/workspace",
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    metrics: {
      steps: 0,
      repairAttempts: 0,
      fallbackDepth: 0,
      deniedToolCalls: 0,
      budgetExceeded: false,
    },
    approvals: { approved: 0, denied: 0, edited: 0 },
    unsafeAutoApprove: false,
    ...overrides,
  };
}
