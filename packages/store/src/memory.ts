// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  Event,
  TraceId,
  type Event as StoredEvent,
  type Id,
  type NewEvent,
  type Snapshot,
} from "@harness/schemas";
import {
  JsonContentCodec,
  decodeSnapshot,
  encodeSnapshot,
  snapshotKeep,
  validateSnapshotAppend,
  type ContentCodec,
  type EncodedSnapshot,
} from "./codec.js";
import { InvalidEventError, SeqConflictError, StoreUnavailableError } from "./errors.js";
import {
  type EventStore,
  type ListRunsOptions,
  type RunSummary,
  type SnapshotStoreOptions,
} from "./types.js";

function startAfterCursor(summaries: readonly RunSummary[], cursor?: string): number | undefined {
  if (cursor === undefined) {
    return 0;
  }

  const cursorIndex = summaries.findIndex((summary) => summary.runId === cursor);
  if (cursorIndex === -1) {
    return undefined;
  }
  return cursorIndex + 1;
}

function validateEventBatch(
  runId: Id,
  events: readonly NewEvent[],
  expectedSeq: number,
  storedLength: number,
): StoredEvent[] {
  if (events.length === 0) {
    throw new InvalidEventError([[]]);
  }
  const validated = events.map((event, index) => {
    if (event.runId !== runId) {
      throw new InvalidEventError([["runId"]]);
    }
    const result = Event.safeParse({ ...event, seq: expectedSeq + index });
    if (!result.success) {
      const paths = result.error.issues.map(({ path }) =>
        path.flatMap((part) =>
          typeof part === "string" || typeof part === "number" ? [part] : [],
        ),
      );
      throw new InvalidEventError(paths);
    }
    return result.data;
  });
  if (storedLength === 0 && validated[0]?.type !== "run_created") {
    throw new InvalidEventError([[0, "type"]]);
  }
  return validated;
}

function hasDuplicateSnapshot(
  snapshotsByRun: ReadonlyMap<Id, readonly EncodedSnapshot[]>,
  snapshotId: Id,
): boolean {
  return [...snapshotsByRun.values()].some((snapshots) =>
    snapshots.some((snapshot) => snapshot.snapshot_id === snapshotId),
  );
}

/** In-memory reference implementation of the append-only event store contract. */
export class InMemoryEventStore implements EventStore {
  private readonly runs = new Map<Id, StoredEvent[]>();
  private readonly traceRuns = new Map<TraceId, Map<Id, number>>();
  private readonly snapshots = new Map<Id, EncodedSnapshot[]>();
  private readonly outboxEvents: { globalSeq: number; event: StoredEvent }[] = [];
  private readonly sinkCursors = new Map<string, number>();
  private nextGlobalSeq = 0;
  private readonly codec: ContentCodec;
  private readonly snapshotKeep: number;

  /** Create an in-memory event store with optional snapshot content encoding and retention. */
  constructor(codec: ContentCodec = new JsonContentCodec(), options: SnapshotStoreOptions = {}) {
    this.codec = codec;
    this.snapshotKeep = snapshotKeep(options);
  }

  /** {@inheritDoc EventStore.append} */
  append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
  ): Promise<{ nextSeq: number }> {
    try {
      return Promise.resolve(this.appendEvents(runId, events, expectedSeq));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new StoreUnavailableError());
    }
  }

  /** {@inheritDoc EventStore.appendWithSnapshot} */
  async appendWithSnapshot(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Snapshot,
  ): Promise<{ nextSeq: number }> {
    try {
      const validatedSnapshot = validateSnapshotAppend(runId, events, expectedSeq, snapshot);
      const encodedSnapshot = await encodeSnapshot(this.codec, validatedSnapshot);
      return this.appendEvents(runId, events, expectedSeq, encodedSnapshot);
    } catch (error) {
      throw error instanceof Error ? error : new StoreUnavailableError();
    }
  }

  private appendEvents(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    encodedSnapshot?: EncodedSnapshot,
  ): { nextSeq: number } {
    const stored = this.runs.get(runId) ?? [];
    if (expectedSeq !== stored.length) {
      throw new SeqConflictError(expectedSeq, stored.length);
    }

    const validated = validateEventBatch(runId, events, expectedSeq, stored.length);

    const runSnapshots = this.snapshots.get(runId) ?? [];
    if (
      encodedSnapshot !== undefined &&
      hasDuplicateSnapshot(this.snapshots, encodedSnapshot.snapshot_id)
    ) {
      throw new InvalidEventError([["snapshotId"]]);
    }

    this.runs.set(runId, [...stored, ...validated]);
    this.recordTraceRuns(runId, validated);
    if (encodedSnapshot !== undefined) {
      this.snapshots.set(
        runId,
        [...runSnapshots, encodedSnapshot]
          .sort((left, right) => right.at_seq - left.at_seq)
          .slice(0, this.snapshotKeep),
      );
    }
    return { nextSeq: expectedSeq + validated.length };
  }

  private recordTraceRuns(runId: Id, events: readonly StoredEvent[]): void {
    for (const event of events) {
      let runs = this.traceRuns.get(event.traceId);
      if (runs === undefined) {
        runs = new Map<Id, number>();
        this.traceRuns.set(event.traceId, runs);
      }
      if (!runs.has(runId)) {
        runs.set(runId, this.nextGlobalSeq);
      }
      this.outboxEvents.push({
        globalSeq: this.nextGlobalSeq + 1,
        event: structuredClone(event),
      });
      this.nextGlobalSeq += 1;
    }
  }

  /** {@inheritDoc EventStore.latestSnapshot} */
  async latestSnapshot(runId: Id): Promise<Snapshot | undefined> {
    const latest = this.snapshots.get(runId)?.[0];
    return latest === undefined ? undefined : decodeSnapshot(this.codec, latest);
  }

  /** {@inheritDoc EventStore.read} */
  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<StoredEvent> {
    const stored = this.runs.get(runId) ?? [];
    const fromSeq = range?.fromSeq ?? 0;
    const toSeq = range?.toSeq ?? Number.POSITIVE_INFINITY;
    const selected = stored.filter((event) => event.seq >= fromSeq && event.seq <= toSeq);
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next(): Promise<IteratorResult<StoredEvent>> {
            const event = selected[index];
            if (event === undefined) {
              return Promise.resolve({ done: true, value: undefined });
            }
            index += 1;
            return Promise.resolve({ done: false, value: structuredClone(event) });
          },
        };
      },
    };
  }

  /** {@inheritDoc EventStore.head} */
  head(runId: Id): Promise<number> {
    return Promise.resolve(this.runs.get(runId)?.length ?? 0);
  }

  /** {@inheritDoc EventStore.listRuns} */
  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      return Promise.reject(new InvalidEventError([["limit"]]));
    }

    const summaries: RunSummary[] = [];
    for (const [runId, events] of this.runs) {
      const created = events.find((event) => event.type === "run_created");
      const last = events.at(-1);
      if (created === undefined || last === undefined) {
        continue;
      }

      let status: RunSummary["status"] = "pending";
      for (const event of events) {
        if (event.type === "run_status_changed") {
          status = event.to;
        }
      }
      if (opts.status !== undefined && opts.status !== status) {
        continue;
      }
      summaries.push({
        runId,
        createdAt: created.ts,
        status,
        lastSeq: last.seq,
        lastTs: last.ts,
      });
    }

    summaries.sort((left, right) => {
      const createdAtOrder = right.createdAt - left.createdAt;
      if (createdAtOrder !== 0) {
        return createdAtOrder;
      }
      return left.runId.localeCompare(right.runId);
    });

    const start = startAfterCursor(summaries, opts.cursor);
    if (start === undefined) {
      return Promise.reject(new InvalidEventError([["cursor"]]));
    }

    const end = start + opts.limit;
    const runs = summaries.slice(start, end);
    const nextCursor = end < summaries.length ? runs.at(-1)?.runId : undefined;
    return Promise.resolve(nextCursor === undefined ? { runs } : { runs, nextCursor });
  }

  /** {@inheritDoc EventStore.findRunsByTrace} */
  findRunsByTrace(traceId: TraceId): Promise<Id[]> {
    if (!TraceId.safeParse(traceId).success) {
      return Promise.reject(new InvalidEventError([["traceId"]]));
    }
    const runs = this.traceRuns.get(traceId);
    if (runs === undefined) {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      [...runs.entries()].sort((left, right) => left[1] - right[1]).map(([runId]) => runId),
    );
  }

  /** {@inheritDoc EventStore.fetchOutbox} */
  fetchOutbox(sinkId: Code, limit: number): Promise<{ events: StoredEvent[]; cursor: number }> {
    const parsedSinkId = Code.safeParse(sinkId);
    if (!parsedSinkId.success) {
      return Promise.reject(new InvalidEventError([["sinkId"]]));
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return Promise.reject(new InvalidEventError([["limit"]]));
    }
    const lastAcked = this.sinkCursors.get(parsedSinkId.data) ?? 0;
    const batch = this.outboxEvents
      .filter(({ globalSeq }) => globalSeq > lastAcked)
      .slice(0, limit);
    return Promise.resolve({
      events: batch.map(({ event }) => structuredClone(event)),
      cursor: batch.at(-1)?.globalSeq ?? lastAcked,
    });
  }

  /** {@inheritDoc EventStore.ackOutbox} */
  ackOutbox(sinkId: Code, cursor: number): Promise<void> {
    const parsedSinkId = Code.safeParse(sinkId);
    if (!parsedSinkId.success) {
      return Promise.reject(new InvalidEventError([["sinkId"]]));
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return Promise.reject(new InvalidEventError([["cursor"]]));
    }
    const previous = this.sinkCursors.get(parsedSinkId.data) ?? 0;
    if (cursor > previous) {
      this.sinkCursors.set(parsedSinkId.data, cursor);
    }
    return Promise.resolve();
  }

  /** {@inheritDoc EventStore.close} */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
