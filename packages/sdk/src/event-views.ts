// SPDX-License-Identifier: Apache-2.0
import {
  JsonValue as JsonValueSchema,
  splitEvent,
  type Event,
  type Id,
  type KeyProvider,
} from "@rovinos/schemas";
import type { Runtime } from "@rovinos/core";
import type { SafeEvent } from "@rovinos/telemetry";
import { POLICY_VERSION, toSafeEvent } from "@rovinos/telemetry";
import { pseudonymize } from "@rovinos/vault";

/** Reads all stored events for one run. */
export async function readEvents(runtime: Runtime, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runtime.store.read(runId)) {
    events.push(event);
  }
  return events;
}

/** Projects events through the safe-event allowlist and optionally adds principal pseudonyms. */
export async function safeEvents(
  events: readonly Event[],
  correlationEnabled: boolean,
  keyProvider: KeyProvider,
): Promise<SafeEvent[]> {
  const projected = await Promise.all(
    events.map(async (event) => {
      if (!correlationEnabled) {
        return toSafeEvent(event, POLICY_VERSION);
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
        return toSafeEvent(event, POLICY_VERSION, pseudonyms);
      } catch {
        return toSafeEvent(event, POLICY_VERSION);
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
