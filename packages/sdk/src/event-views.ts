// SPDX-License-Identifier: Apache-2.0
import {
  JsonValue as JsonValueSchema,
  splitEvent,
  type Code,
  type Event,
  type Id,
  type KeyProvider,
} from "@harness/schemas";
import type { Runtime } from "@harness/core";
import type { SafeEvent } from "@harness/telemetry";
import { toSafeEvent } from "@harness/telemetry";
import { pseudonymize } from "@harness/vault";

/** Reads all stored events for one run. */
export async function readEvents(runtime: Runtime, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runtime.store.read(runId)) {
    events.push(event);
  }
  return events;
}

/** Projects events through the safe-event allowlist and optionally pseudonymizes principals. */
export async function safeEvents(
  events: readonly Event[],
  policyVersion: Code,
  correlationEnabled: boolean,
  keyProvider: KeyProvider,
): Promise<SafeEvent[]> {
  const projected = await Promise.all(
    events.map(async (event) => {
      if (!correlationEnabled) {
        return toSafeEvent(event, policyVersion);
      }
      try {
        const pseudonyms = {
          ...(event.type === "run_created" && event.requestedBy !== undefined
            ? {
                requestedBy: await pseudonymize({
                  value: event.requestedBy,
                  scope: "global",
                  keyProvider,
                }),
              }
            : {}),
          ...(event.type === "approval_resolved" && event.approverId !== undefined
            ? {
                approverId: await pseudonymize({
                  value: event.approverId,
                  scope: "global",
                  keyProvider,
                }),
              }
            : {}),
        };
        return toSafeEvent(event, policyVersion, pseudonyms);
      } catch {
        return toSafeEvent(event, policyVersion);
      }
    }),
  );
  return projected.filter((event): event is SafeEvent => event !== null);
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
