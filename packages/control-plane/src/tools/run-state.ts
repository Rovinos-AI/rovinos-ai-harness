// SPDX-License-Identifier: Apache-2.0
import { foldRunState, type RunState } from "@harness/core";
import type { Event, Id } from "@harness/schemas";
import type { EventStore } from "@harness/store";

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
