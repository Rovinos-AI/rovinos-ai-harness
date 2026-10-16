// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type Id } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { IdGenerator } from "./ports.js";
import { CorruptLogError, foldRunState, isTerminalRunState } from "./run-state.js";
import { LeaseLostError, RunRecorder, type Clock } from "./recorder.js";
import { RUN_SPAN } from "./spans.js";

/** Result of attempting to cancel a run. */
export type CancelRunResult = "cancelled" | "already_terminal";

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
  return cancelRunTree({
    store,
    runId,
    clock,
    ids,
    visited: new Set(),
    visiting: new Set(),
  });
}

async function cancelRunTree(options: {
  readonly store: EventStore;
  readonly runId: Id;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly visited: Set<Id>;
  readonly visiting: Set<Id>;
}): Promise<CancelRunResult> {
  const { store, runId, clock, ids, visited, visiting } = options;
  if (visiting.has(runId)) {
    throw new CorruptLogError();
  }
  if (visited.has(runId)) {
    return "already_terminal";
  }
  visited.add(runId);
  visiting.add(runId);
  const events = await readEvents(store, runId);
  const completed = new Set(
    events.flatMap((event) => (event.type === "subagent_completed" ? [event.childRunId] : [])),
  );
  const children = new Set(
    events.flatMap((event) =>
      event.type === "subagent_spawned" && !completed.has(event.childRunId)
        ? [event.childRunId]
        : [],
    ),
  );
  for (const childRunId of children) {
    await cancelRunTree({ ...options, runId: childRunId });
    await completeCancelledChild({ store, parentRunId: runId, childRunId, clock, ids });
  }

  const result = await cancelSingleRun(store, runId, clock, ids);
  visiting.delete(runId);
  return result;
}

async function completeCancelledChild(options: {
  readonly store: EventStore;
  readonly parentRunId: Id;
  readonly childRunId: Id;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}): Promise<void> {
  const { store, parentRunId, childRunId, clock, ids } = options;
  const [parentEvents, childEvents] = await Promise.all([
    readEvents(store, parentRunId),
    readEvents(store, childRunId),
  ]);
  if (
    parentEvents.some(
      (event) => event.type === "subagent_completed" && event.childRunId === childRunId,
    )
  ) {
    return;
  }
  const childState = foldRunState(childEvents);
  if (!isTerminalRunState(childState)) {
    throw new CorruptLogError();
  }
  if (
    childState.status !== "completed" &&
    childState.status !== "failed" &&
    childState.status !== "cancelled"
  ) {
    throw new CorruptLogError();
  }
  const outcome = childState.status;
  const recorder = new RunRecorder(
    store,
    parentRunId,
    ids.next(),
    foldRunState(parentEvents).nextSeq,
    clock,
  );
  try {
    await recorder.withStepSpan(RUN_SPAN, {}, () =>
      recorder.record({
        type: "subagent_completed",
        v: 1,
        childRunId,
        outcome,
        inputTokens: childState.usage.inputTokens,
        outputTokens: childState.usage.outputTokens,
        steps: childState.steps,
        costMicros: childState.usage.costMicros,
      }),
    );
  } catch (error) {
    if (
      error instanceof LeaseLostError &&
      (await readEvents(store, parentRunId)).some(
        (event) => event.type === "subagent_completed" && event.childRunId === childRunId,
      )
    ) {
      return;
    }
    throw error;
  }
}

async function cancelSingleRun(
  store: EventStore,
  runId: Id,
  clock: Clock,
  ids: IdGenerator,
): Promise<CancelRunResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [events, head] = await Promise.all([readEvents(store, runId), store.head(runId)]);
    const state = foldRunState(events);
    if (isTerminalRunState(state)) {
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
