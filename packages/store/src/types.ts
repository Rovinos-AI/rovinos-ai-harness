// SPDX-License-Identifier: Apache-2.0
import type { Code, Event, Id, NewEvent, RunStatus, Snapshot, TraceId } from "@harness/schemas";
import { z } from "zod";

/** Runtime schema for per-run checkpoint snapshot retention configuration. */
export const snapshotStoreOptionsSchema = z
  .object({ snapshotKeep: z.number().int().min(1).default(5) })
  .strict();

/** Snapshot retention options accepted by an EventStore. */
export type SnapshotStoreOptions = z.input<typeof snapshotStoreOptionsSchema>;

/** SQLite-specific snapshot and offline inspection options. */
export const sqliteStoreOptionsSchema = snapshotStoreOptionsSchema.extend({
  readOnly: z.boolean().default(false),
});

/** Source of epoch-millisecond timestamps used for store metadata. */
export interface Clock {
  /** Return the current epoch time in milliseconds. */
  now(): number;
}

/** System clock used when a store clock is not supplied. */
export const systemClock: Clock = Object.freeze({ now: () => Date.now() });

/** Summary of a run derived from its stored events. */
export interface RunSummary {
  /** Run identifier. */
  runId: Id;
  /** Timestamp of the run_created event, in epoch milliseconds. */
  createdAt: number;
  /** Latest status_changed target, or pending when no status change exists. */
  status: RunStatus;
  /** Sequence number of the last stored event. */
  lastSeq: number;
  /** Timestamp of the last stored event, in epoch milliseconds. */
  lastTs: number;
}

/** Options for listing runs. */
export interface ListRunsOptions {
  /** Restrict results to runs with this latest status. */
  status?: RunStatus;
  /** Restrict results to direct continuations of this run. */
  continuationOf?: Id;
  /** Maximum number of summaries to return. */
  limit: number;
  /** Opaque cursor returned by a previous call to listRuns. */
  cursor?: string;
}

/** Append-only event storage contract. */
export interface EventStore {
  /**
   * Validate and append events atomically, assigning consecutive sequence numbers.
   * @param runId Run identifier to append to.
   * @param events Events without their store-assigned sequence numbers.
   * @param expectedSeq Next sequence number the caller expects.
   * @returns The next free sequence number after the append.
   * @throws SeqConflictError when the stored head differs from expectedSeq.
   * @throws InvalidEventError when an event is invalid or belongs to another run.
   */
  append(runId: Id, events: readonly NewEvent[], expectedSeq: number): Promise<{ nextSeq: number }>;

  /**
   * Validate and append events and their checkpoint snapshot atomically.
   * @param runId Run identifier to append to.
   * @param events Events without their store-assigned sequence numbers.
   * @param expectedSeq Next sequence number the caller expects.
   * @param snapshot Snapshot associated with exactly one checkpoint_written event.
   * @returns The next free sequence number after the append.
   */
  appendWithSnapshot(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Snapshot,
  ): Promise<{ nextSeq: number }>;

  /**
   * Retrieve the retained snapshot with the greatest atSeq for a run.
   * @param runId Run identifier to inspect.
   * @returns The latest snapshot, or undefined when none has been written.
   */
  latestSnapshot(runId: Id): Promise<Snapshot | undefined>;

  /**
   * Read events in sequence order. Both range endpoints are inclusive.
   * @param runId Run identifier to read.
   * @param range Optional inclusive sequence bounds.
   * @returns An async iterable of detached event copies.
   */
  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<Event>;

  /**
   * Return the next free sequence number for a run.
   * @param runId Run identifier to inspect.
   * @returns The next free sequence number, or 0 for an unknown run.
   */
  head(runId: Id): Promise<number>;

  /**
   * List runs ordered by creation timestamp, newest first, with runId cursors.
   * @param opts Filters and pagination options.
   * @returns The selected run summaries and an optional cursor for the next page.
   */
  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }>;

  /**
   * Resolve a trace to all runs that contain it, ordered by first event appearance.
   * Replay uses this to resolve trace input and identify related runs.
   * @param traceId Trace identifier to search for.
   * @returns Matching run identifiers, or an empty array when none match.
   * @throws InvalidEventError when traceId is invalid.
   */
  findRunsByTrace(traceId: TraceId): Promise<Id[]>;

  /**
   * Fetch the next at-least-once batch of events for a sink.
   * @param sinkId Sink identifier with an independent persisted cursor.
   * @param limit Maximum number of events to return.
   * @returns Ordered events and the cursor after the last returned event, or the acked cursor if empty.
   */
  fetchOutbox(sinkId: Code, limit: number): Promise<{ events: Event[]; cursor: number }>;

  /**
   * Advance a sink's outbox cursor monotonically.
   * @param sinkId Sink identifier.
   * @param cursor Cursor returned by {@link EventStore.fetchOutbox}.
   */
  ackOutbox(sinkId: Code, cursor: number): Promise<void>;

  /** Release resources held by the store. */
  close(): Promise<void>;
}
