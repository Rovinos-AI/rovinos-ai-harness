// SPDX-License-Identifier: Apache-2.0
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { type Event, type Id } from "@harness/schemas";
import { type EventStore } from "@harness/store";
import { countDroppedTelemetry, sentinelTripQueue } from "@harness/telemetry";
import { RunRecorder } from "./recorder.js";
import type { Clock } from "./recorder.js";
import type { RunLoopResult } from "./loop.js";

/** Flush telemetry and append any queued run trips after its run-loop span ends. */
export async function flushAndDrainTrips(options: {
  readonly store: EventStore;
  readonly runId: Id;
  readonly clock: Clock;
  readonly flushTelemetry?: (() => Promise<void>) | undefined;
}): Promise<Event[]> {
  const { store, runId, clock, flushTelemetry } = options;
  try {
    try {
      await flushTelemetry?.();
    } catch {
      countDroppedTelemetry("trip_flush_failed");
    }
    if (!sentinelTripQueue.hasForRun(runId)) {
      return [];
    }
    const nextSeq = await store.head(runId);
    if (nextSeq === 0) {
      throw new Error("Sentinel trip has no run log.");
    }
    let tail: Event | undefined;
    for await (const event of store.read(runId, {
      fromSeq: nextSeq - 1,
      toSeq: nextSeq - 1,
    })) {
      tail = event;
      break;
    }
    if (tail === undefined) {
      throw new Error("Sentinel trip has no run log tail.");
    }
    const recorder = new RunRecorder(store, runId, tail.segmentId, nextSeq, clock);
    const spanContext = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: tail.traceId,
      spanId: tail.spanId,
      traceFlags: 0,
    });
    return await context.with(spanContext, () => recorder.drainTrips());
  } catch {
    countDroppedTelemetry("trip_append_failed");
    sentinelTripQueue.drainForRun(runId);
    return [];
  } finally {
    sentinelTripQueue.discardRun(runId);
  }
}

/** Add final trip events to the returned result and advance its folded envelope state. */
export async function appendFinalRunTrips(
  result: RunLoopResult,
  options: Parameters<typeof flushAndDrainTrips>[0],
): Promise<RunLoopResult> {
  const tripEvents = await flushAndDrainTrips(options);
  const lastTrip = tripEvents.at(-1);
  if (lastTrip === undefined) {
    return result;
  }
  return {
    ...result,
    events: [...result.events, ...tripEvents],
    state: {
      ...result.state,
      nextSeq: lastTrip.seq + 1,
      segmentId: lastTrip.segmentId,
      lastTs: lastTrip.ts,
    },
  };
}
