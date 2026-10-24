// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";
import type { Checkpointer } from "../checkpoint.js";
import type { RunRecorder } from "../recorder.js";
import { foldRunState } from "../run-state.js";

/** Records the shutdown suspension between recorder-owned sentinel trip drains. */
export async function suspendForShutdown(
  recorder: RunRecorder,
  events: Event[],
  checkpointer: Checkpointer,
): Promise<Event> {
  events.push(...(await recorder.drainTrips()));
  const suspended = await recorder.record({
    type: "run_status_changed",
    v: 1,
    from: "running",
    to: "suspended",
    reason: "shutdown",
  });
  events.push(suspended);
  events.push(...(await recorder.drainTrips()));
  const checkpoint = await checkpointer.maybeCheckpoint(foldRunState(events));
  if (checkpoint !== undefined) {
    events.push(checkpoint);
  }
  return suspended;
}
