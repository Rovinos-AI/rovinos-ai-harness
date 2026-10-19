// SPDX-License-Identifier: Apache-2.0
import type { Event, Id } from "@harness/schemas";
import type { Link } from "@opentelemetry/api";
import type { EventStore } from "@harness/store";
import { CorruptLogError } from "./run-state.js";
import type { RunScopeRegistry } from "./subagent/scope.js";

/** Reads a complete run log from its event store. */
export async function readRunEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

interface ScopeRestoreOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly events: readonly Event[];
  readonly scopes: RunScopeRegistry;
  readonly visited: Set<Id>;
}

async function registerRunScope(options: ScopeRestoreOptions): Promise<void> {
  const { store, runId, events, scopes, visited } = options;
  const created = events.find((event) => event.type === "run_created");
  if (created?.type !== "run_created" || visited.has(runId)) {
    throw new CorruptLogError();
  }
  visited.add(runId);
  if (created.parentRunId === undefined) {
    scopes.register(runId, created.scopeId ?? runId);
    return;
  }
  const parentEvents = await readRunEvents(store, created.parentRunId);
  if (parentEvents.length === 0 && created.scopeId !== undefined) {
    scopes.register(runId, created.scopeId);
    return;
  }
  await registerRunScope({
    store,
    runId: created.parentRunId,
    events: parentEvents,
    scopes,
    visited,
  });
  const parentScope = scopes.scopeOf(created.parentRunId);
  if (created.scopeId !== undefined && created.scopeId !== parentScope) {
    throw new CorruptLogError();
  }
  scopes.register(runId, parentScope);
}

/** Re-registers a run's inherited scope by walking its durable parent chain. */
export function restoreRunScope(
  store: EventStore,
  runId: Id,
  events: readonly Event[],
  scopes: RunScopeRegistry,
): Promise<void> {
  return registerRunScope({ store, runId, events, scopes, visited: new Set<Id>() });
}

function linkFromTraceparent(traceparent: string): Link | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u.exec(traceparent);
  const traceId = match?.[1];
  const spanId = match?.[2];
  const flags = match?.[3];
  if (traceId === undefined || spanId === undefined || flags === undefined) {
    return undefined;
  }
  return {
    context: {
      traceId,
      spanId,
      traceFlags: Number.parseInt(flags, 16),
      isRemote: true,
    },
  };
}

/** Builds a link to the prior run segment or its checkpoint traceparent. */
export function previousSegmentLink(events: readonly Event[], traceparent?: string): Link {
  const checkpointLink = traceparent === undefined ? undefined : linkFromTraceparent(traceparent);
  if (checkpointLink !== undefined) {
    return checkpointLink;
  }
  const last = events.at(-1);
  if (last === undefined) {
    throw new Error("Expected a prior run event.");
  }
  return {
    context: {
      traceId: last.traceId,
      spanId: last.spanId,
      traceFlags: 1,
      isRemote: true,
    },
  };
}
