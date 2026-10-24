// SPDX-License-Identifier: Apache-2.0
// Approval resume wake-up, extracted from runtime.ts (keeps it under the max-lines limit).
import type { Id } from "@rovinos/schemas";
import type { RunQueue } from "@rovinos/store";
import { ApprovalAlreadyResolvedError } from "./approvals.js";

/**
 * Resolves an approval and enqueues the run's resume job when auto-resume is on.
 *
 * A retry after a crash between the decision and the enqueue sees
 * `ApprovalAlreadyResolvedError`; it still enqueues, so the resume intent is never lost.
 */
export async function withResumeWakeUp<T>(
  queue: RunQueue | undefined,
  autoResume: boolean,
  runId: Id,
  resolve: () => Promise<T>,
): Promise<T> {
  const wake = queue !== undefined && autoResume;
  try {
    const resolved = await resolve();
    if (wake) {
      await queue.enqueue({ kind: "resume", runId });
    }
    return resolved;
  } catch (error) {
    if (wake && error instanceof ApprovalAlreadyResolvedError) {
      await queue.enqueue({ kind: "resume", runId });
    }
    throw error;
  }
}
