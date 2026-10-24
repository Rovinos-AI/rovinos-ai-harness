// SPDX-License-Identifier: Apache-2.0
import { foldRunState, type ApprovalRequestedEvent, type RunState } from "@rovinos/core";
import type { Event, Id } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";

/** Reads and folds one run's events, returning undefined when the run is unknown. */
export async function readRunState(
  store: EventStore,
  runId: Id,
): Promise<
  | {
      events: Event[];
      state: RunState;
      policyVersion: Extract<Event, { type: "run_created" }>["policyVersion"];
    }
  | undefined
> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  if (events.length === 0) {
    return undefined;
  }
  const state = foldRunState(events);
  const runCreated = events[0];
  if (runCreated?.type !== "run_created") {
    return undefined;
  }
  return { events, state, policyVersion: runCreated.policyVersion };
}

/** Finds an approval request and its owning run without returning approval content. */
export async function findApprovalRequest(
  store: EventStore,
  approvalId: Id,
  runIds?: readonly Id[],
): Promise<
  | {
      readonly runId: Id;
      readonly request: ApprovalRequestedEvent;
      readonly resolved: boolean;
    }
  | undefined
> {
  if (runIds !== undefined) {
    for (const runId of new Set(runIds)) {
      const run = await readRunState(store, runId);
      const request = run?.state.approvalRequests.get(approvalId);
      if (run !== undefined && request !== undefined) {
        return {
          runId,
          request,
          resolved: run.state.resolvedApprovals.has(approvalId),
        };
      }
    }
    return undefined;
  }
  let cursor: string | undefined;
  for (;;) {
    const page = await store.listRuns({ limit: 50, ...(cursor === undefined ? {} : { cursor }) });
    for (const summary of page.runs) {
      const run = await readRunState(store, summary.runId);
      if (run === undefined) {
        continue;
      }
      const request = run.state.approvalRequests.get(approvalId);
      if (request !== undefined) {
        return {
          runId: summary.runId,
          request,
          resolved: run.state.resolvedApprovals.has(approvalId),
        };
      }
    }
    if (page.nextCursor === undefined || page.nextCursor === cursor) {
      return undefined;
    }
    cursor = page.nextCursor;
  }
}
