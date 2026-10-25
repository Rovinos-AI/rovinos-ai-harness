// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";

/** Returns the latest durable suspension event from a run history. */
export function suspendedOutcome(events: readonly Event[]): Event {
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.type === "run_status_changed" && candidate.to === "suspended");
  if (event === undefined) {
    throw new Error("Expected a suspension status event.");
  }
  return event;
}
