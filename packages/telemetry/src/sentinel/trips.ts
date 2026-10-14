// SPDX-License-Identifier: Apache-2.0
import { logs, type Logger } from "@opentelemetry/api-logs";
import { Code, Id } from "@harness/schemas";
import { z } from "zod";
import { countDroppedTelemetry } from "../metrics.js";
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
const TripQueueOptionsSchema = z
  .object({
    maxEntries: z.number().int().positive().max(1_000).default(1_000),
  })
  .strict();

interface TripNode {
  readonly trip: QueuedSentinelTrip;
  previous: TripNode | undefined;
  next: TripNode | undefined;
}

/**
 * Retains run-scoped sentinel alerts until their run loop can append them safely.
 */
export class TripQueue {
  private readonly tripsByRun = new Map<Id, TripNode[]>();
  private readonly discardedRuns = new Map<Id, undefined>();
  private first: TripNode | undefined;
  private last: TripNode | undefined;
  private entryCount = 0;
  private readonly maxEntries: number;

  /**
   * @param logger - Sanctioned telemetry logger used for every trip, including global scans.
   * @param options - Maximum number of retained run-scoped trips.
   */
  constructor(
    private readonly logger: Logger = logs.getLogger("@harness/telemetry"),
    options: z.input<typeof TripQueueOptionsSchema> = {},
  ) {
    this.maxEntries = TripQueueOptionsSchema.parse(options).maxEntries;
  }

  /** Number of retained run-scoped trips. */
  get size(): number {
    return this.entryCount;
  }

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
      if (this.discardedRuns.has(runId)) {
        countDroppedTelemetry("trip_discarded");
        return;
      }
      this.insertLast({ runId, entities });
    }
  }

  /** Remove and return only trips owned by the requested run. */
  drainForRun(runId: Id): readonly QueuedSentinelTrip[] {
    const nodes = this.tripsByRun.get(runId);
    if (nodes === undefined) {
      return [];
    }
    this.tripsByRun.delete(runId);
    for (const node of nodes) {
      this.unlink(node);
    }
    return nodes.map(({ trip }) => trip);
  }

  /** Put trips back after a failed recorder append without logging them twice. */
  restore(trips: readonly QueuedSentinelTrip[]): void {
    for (let index = trips.length - 1; index >= 0; index -= 1) {
      const trip = trips[index];
      if (trip !== undefined) {
        this.insertFirst(trip);
      }
    }
  }

  /** Return whether a run has trips awaiting append. */
  hasForRun(runId: Id): boolean {
    return (this.tripsByRun.get(runId)?.length ?? 0) > 0;
  }

  /**
   * Discard retained trips and prevent late checks from refilling a completed run's queue.
   * The suppression set is bounded by the same limit as the queue.
   */
  discardRun(runId: Id): void {
    const discarded = this.drainForRun(runId);
    if (discarded.length > 0) {
      countDroppedTelemetry("trip_discarded");
    }
    this.discardedRuns.delete(runId);
    this.discardedRuns.set(runId, undefined);
    while (this.discardedRuns.size > this.maxEntries) {
      const oldestRunId = this.discardedRuns.keys().next().value;
      if (oldestRunId === undefined) {
        break;
      }
      this.discardedRuns.delete(oldestRunId);
    }
  }

  private insertLast(trip: QueuedSentinelTrip): void {
    const node: TripNode = { trip, previous: this.last, next: undefined };
    if (this.last === undefined) {
      this.first = node;
    } else {
      this.last.next = node;
    }
    this.last = node;
    const runTrips = this.tripsByRun.get(trip.runId);
    if (runTrips === undefined) {
      this.tripsByRun.set(trip.runId, [node]);
    } else {
      runTrips.push(node);
    }
    this.entryCount += 1;
    this.dropOverflow();
  }

  private insertFirst(trip: QueuedSentinelTrip): void {
    const node: TripNode = { trip, previous: undefined, next: this.first };
    if (this.first === undefined) {
      this.last = node;
    } else {
      this.first.previous = node;
    }
    this.first = node;
    const runTrips = this.tripsByRun.get(trip.runId);
    if (runTrips === undefined) {
      this.tripsByRun.set(trip.runId, [node]);
    } else {
      runTrips.unshift(node);
    }
    this.entryCount += 1;
    this.dropOverflow();
  }

  private dropOverflow(): void {
    while (this.entryCount > this.maxEntries) {
      const oldest = this.first;
      if (oldest === undefined) {
        return;
      }
      this.unlink(oldest);
      const runTrips = this.tripsByRun.get(oldest.trip.runId);
      if (runTrips !== undefined) {
        runTrips.shift();
        if (runTrips.length === 0) {
          this.tripsByRun.delete(oldest.trip.runId);
        }
      }
      countDroppedTelemetry("trip_queue_overflow");
    }
  }

  private unlink(node: TripNode): void {
    const current = node;
    if (current.previous === undefined) {
      this.first = current.next;
    } else {
      current.previous.next = current.next;
    }
    if (current.next === undefined) {
      this.last = current.previous;
    } else {
      current.next.previous = current.previous;
    }
    current.previous = undefined;
    current.next = undefined;
    this.entryCount -= 1;
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
