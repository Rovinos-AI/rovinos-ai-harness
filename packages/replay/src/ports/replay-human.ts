// SPDX-License-Identifier: Apache-2.0
import type { ApprovalDecision, ApprovalResolutionMetadata } from "@rovinos/core";
import { HarnessError, type Event, type Id, type JsonValue } from "@rovinos/schemas";
import type { ResolvedRun } from "../resolve.js";

type ResolvedApproval = Extract<Event, { type: "approval_resolved" }>;

interface ReplayApprovalRuntime {
  resolveApproval(
    runId: Id,
    approvalId: Id,
    decision: ApprovalDecision,
    options?: { readonly edits?: JsonValue; readonly metadata?: ApprovalResolutionMetadata },
  ): Promise<unknown>;
  resume(runId: Id): Promise<unknown>;
}

/** Replays recorded approval decisions through the runtime's normal resolve-and-resume path. */
export class ReplayHuman {
  readonly alreadyTokenized = true;
  private readonly approvals = new Map<Id, ResolvedApproval[]>();
  private readonly positions = new Map<Id, number>();

  /** @param resolved - Event logs containing approval request/response pairs. */
  constructor(resolved: ResolvedRun) {
    const requests = new Map<Id, Extract<Event, { type: "approval_requested" }>>();
    const events = resolved.runs.flatMap((run) => run.events);
    for (const event of events) {
      if (event.type === "approval_requested") {
        requests.set(event.approvalId, event);
      } else if (event.type === "approval_resolved") {
        const request = requests.get(event.approvalId);
        if (request !== undefined) {
          const items = this.approvals.get(request.callId) ?? [];
          items.push(event);
          this.approvals.set(request.callId, items);
        }
      }
    }
  }

  /**
   * Applies a recorded approval, then resumes the suspended run through core.
   *
   * @param runtime - Isolated replay runtime.
   * @param runId - Replay run to resolve.
   * @param callId - Tool call whose recorded approval decision should be applied.
   * @returns The resumed run-loop outcome.
   */
  async resolveAndResume(runtime: ReplayApprovalRuntime, runId: Id, callId: Id): Promise<void> {
    const index = this.positions.get(callId) ?? 0;
    const recorded = this.approvals.get(callId)?.[index];
    if (recorded === undefined) {
      throw new ReplayApprovalMissingError();
    }
    this.positions.set(callId, index + 1);
    await runtime.resolveApproval(runId, recorded.approvalId, recorded.decision, {
      ...(recorded.edits === undefined ? {} : { edits: recorded.edits }),
      metadata: {
        decidedBy: recorded.decidedBy,
        ...(recorded.approverId === undefined ? {} : { approverId: recorded.approverId }),
        ...(recorded.reason === undefined ? {} : { reason: recorded.reason }),
      },
    });
    await runtime.resume(runId);
  }
}

/** Raised when an approval call has no recorded resolution. */
export class ReplayApprovalMissingError extends HarnessError {
  readonly code = "replay_missing_result";

  constructor() {
    super("A recorded approval resolution is unavailable.");
  }
}
