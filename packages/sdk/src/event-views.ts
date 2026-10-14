// SPDX-License-Identifier: Apache-2.0
import {
  JsonValue as JsonValueSchema,
  splitEvent,
  type Code,
  type Event,
  type Id,
} from "@harness/schemas";
import type { Runtime } from "@harness/core";
import type { SafeEvent } from "@harness/telemetry";
import { toSafeEvent } from "@harness/telemetry";

/** Reads all stored events for one run. */
export async function readEvents(runtime: Runtime, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runtime.store.read(runId)) {
    events.push(event);
  }
  return events;
}

/** Projects events through the public safe-event allowlist. */
export function safeEvents(events: readonly Event[], policyVersion: Code): SafeEvent[] {
  return events.flatMap((event) => {
    const safe = toSafeEvent(event, policyVersion);
    return safe === null ? [] : [safe];
  });
}

/** Selects tokenized content entries from events for explicit content access. */
export function contentEntries(events: readonly Event[]): unknown[] {
  return events.flatMap((event) => {
    const content = splitEvent(event).content;
    if (Object.keys(content).length === 0) {
      return [];
    }
    return [{ seq: event.seq, type: event.type, content: JsonValueSchema.parse(content) }];
  });
}
