// SPDX-License-Identifier: Apache-2.0
import { logs, type Logger } from "@opentelemetry/api-logs";
import { Code, Id } from "@harness/schemas";
import { z } from "zod";
import { emitSentinelTrip } from "../safe-event-logs.js";

const SentinelTripEntitySchema = z
  .object({
    type: Code,
    count: z.number().int().nonnegative(),
  })
  .strict();

/** Metadata-only notice that a telemetry payload was rejected by the sentinel. */
export const SentinelTripSchema = z
  .object({
    runId: Id.optional(),
    entities: z.array(SentinelTripEntitySchema),
  })
  .strict();

/** Inferred sentinel trip notification. */
export type SentinelTrip = z.infer<typeof SentinelTripSchema>;

/** A run-scoped trip retained until its recorder appends it. */
export type QueuedSentinelTrip = SentinelTrip & { readonly runId: Id };

const TripQueueInputSchema = SentinelTripSchema;

/**
 * Retains run-scoped sentinel alerts until their run loop can append them safely.
 */
export class TripQueue {
  private readonly trips: QueuedSentinelTrip[] = [];

  /**
   * @param logger - Sanctioned telemetry logger used for every trip, including global scans.
   */
  constructor(private readonly logger: Logger = logs.getLogger("@harness/telemetry")) {}

  /**
   * Log a metadata-only trip and queue it only when it belongs to a run.
   *
   * @param input - Optional run ID and counts by vault entity type.
   */
  enqueue(input: SentinelTrip): void {
    const parsed = TripQueueInputSchema.parse(input);
    const entities = aggregateEntities(parsed.entities);
    const runId = parsed.runId;
    try {
      emitSentinelTrip(this.logger, {
        ...(runId === undefined ? {} : { runId }),
        count: entities.reduce((total, entity) => total + entity.count, 0),
      });
    } catch {
      // Logging failures must not discard the trip or affect the telemetry processor.
    }
    if (runId !== undefined) {
      this.trips.push({ runId, entities });
    }
  }

  /** Remove and return only trips owned by the requested run. */
  drainForRun(runId: Id): readonly QueuedSentinelTrip[] {
    const selected: QueuedSentinelTrip[] = [];
    const remaining: QueuedSentinelTrip[] = [];
    for (const trip of this.trips) {
      if (trip.runId === runId) {
        selected.push(trip);
      } else {
        remaining.push(trip);
      }
    }
    this.trips.splice(0, this.trips.length, ...remaining);
    return selected;
  }

  /** Put trips back after a failed recorder append without logging them twice. */
  restore(trips: readonly QueuedSentinelTrip[]): void {
    this.trips.unshift(...trips);
  }
}

/** Process-wide queue shared by telemetry gates and run recorders. */
export const sentinelTripQueue = new TripQueue();

function aggregateEntities(entities: SentinelTrip["entities"]): SentinelTrip["entities"] {
  const counts = new Map<string, number>();
  for (const { type, count } of entities) {
    counts.set(type, (counts.get(type) ?? 0) + count);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => ({ type: Code.parse(type), count }));
}
