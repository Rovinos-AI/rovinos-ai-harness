// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type Id } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { IdGenerator } from "./ports.js";
import { foldRunState } from "./run-state.js";
import { LeaseLostError, RunRecorder, type Clock } from "./recorder.js";
import { RUN_SPAN } from "./spans.js";

/** Result of attempting to cancel a run. */
export type CancelRunResult = "cancelled" | "already_terminal";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

class CancelConflictError extends HarnessError {
  override readonly code = "cancel_conflict";

  constructor() {
    super("The run changed repeatedly while cancellation was being requested.");
  }
}

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

/**
 * Appends a cancellation status event, retrying bounded head races with the live worker.
 *
 * @param store - Event store containing the run's durable history.
 * @param runId - Identifier of the run to cancel.
 * @param clock - Clock used to timestamp the cancellation event.
 * @param ids - Generator used for the cancellation segment identifier.
 * @returns Whether cancellation was appended or the run was already terminal.
 * @throws CancelConflictError when the log keeps advancing during cancellation.
 */
export async function cancelRun(
  store: EventStore,
  runId: Id,
  clock: Clock,
  ids: IdGenerator,
): Promise<CancelRunResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [events, head] = await Promise.all([readEvents(store, runId), store.head(runId)]);
    const state = foldRunState(events);
    if (terminalStatuses.has(state.status)) {
      return "already_terminal";
    }
    if (state.nextSeq !== head) {
      continue;
    }

    const recorder = new RunRecorder(store, runId, ids.next(), head, clock);
    try {
      await recorder.withStepSpan(RUN_SPAN, {}, () =>
        recorder.record({
          type: "run_status_changed",
          v: 1,
          from: state.status,
          to: "cancelled",
          reason: "cancel_requested",
        }),
      );
      return "cancelled";
    } catch (error) {
      if (!(error instanceof LeaseLostError)) {
        throw error;
      }
      if (attempt === 2) {
        throw new CancelConflictError();
      }
    }
  }
  throw new CancelConflictError();
}
