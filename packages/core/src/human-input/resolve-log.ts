// SPDX-License-Identifier: Apache-2.0
import type { Event, Id } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import {
  InputAlreadyResolvedError,
  InputNotFoundError,
  InputRunTerminalError,
} from "./resolve-errors.js";
import { foldRunState, type InputRequestedEvent } from "../run-state.js";

/** Folded state and tail event from a run's complete event log. */
export interface RunLog {
  readonly events: readonly Event[];
  readonly state: ReturnType<typeof foldRunState>;
  readonly lastEvent: Event;
}

/** Reads a complete run log and rejects terminal runs. */
export async function readRunLog(store: EventStore, runId: Id): Promise<RunLog> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  const lastEvent = events.at(-1);
  if (lastEvent === undefined) {
    throw new InputNotFoundError();
  }
  const state = foldRunState(events);
  if (state.status === "cancelled" || state.status === "completed" || state.status === "failed") {
    throw new InputRunTerminalError();
  }
  return { events, state, lastEvent };
}

/** Returns a pending request or raises the appropriate stable resolver error. */
export function pendingRequest(
  state: ReturnType<typeof foldRunState>,
  requestId: Id,
): InputRequestedEvent {
  const request = state.pendingInputs.get(requestId);
  if (request !== undefined) {
    return request;
  }
  if (state.inputRequests.has(requestId)) {
    throw new InputAlreadyResolvedError();
  }
  throw new InputNotFoundError();
}
