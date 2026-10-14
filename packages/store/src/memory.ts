// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  Event,
  RunStatus,
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
  type WatchOptions,
  type WatchRunsOptions,
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

function matchesContinuation(
  created: Extract<StoredEvent, { type: "run_created" }>,
  continuationOf: Id | undefined,
): boolean {
  return continuationOf === undefined || created.continuationOf === continuationOf;
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
  private readonly runWatchers = new Map<Id, Set<() => void>>();
  private readonly runListWatchers = new Set<() => void>();
  private readonly traceRuns = new Map<TraceId, Map<Id, number>>();
  private readonly snapshots = new Map<Id, EncodedSnapshot[]>();
  private readonly outboxEvents: { globalSeq: number; event: StoredEvent }[] = [];
  private readonly sinkCursors = new Map<string, number>();
  private readonly approvalNotifications = new Map<
    Id,
    { readonly runId: Id; readonly claimedAt: number; readonly sentAt?: number }
  >();
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
    this.notifyRunChange(runId);
    return { nextSeq: expectedSeq + validated.length };
  }

  private notifyRunChange(runId: Id): void {
    for (const notify of this.runWatchers.get(runId) ?? []) {
      notify();
    }
    for (const notify of this.runListWatchers) {
      notify();
    }
  }

  private subscribeRun(runId: Id, notify: () => void, signal: AbortSignal): () => void {
    const watchers = this.runWatchers.get(runId) ?? new Set<() => void>();
    watchers.add(notify);
    this.runWatchers.set(runId, watchers);
    signal.addEventListener("abort", notify, { once: true });
    if (signal.aborted) {
      notify();
    }
    return () => {
      watchers.delete(notify);
      signal.removeEventListener("abort", notify);
      if (watchers.size === 0) {
        this.runWatchers.delete(runId);
      }
    };
  }

  private subscribeRunList(notify: () => void, signal: AbortSignal): () => void {
    this.runListWatchers.add(notify);
    signal.addEventListener("abort", notify, { once: true });
    if (signal.aborted) {
      notify();
    }
    return () => {
      this.runListWatchers.delete(notify);
      signal.removeEventListener("abort", notify);
    };
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

  /** {@inheritDoc EventStore.watch} */
  async *watch(runId: Id, options: WatchOptions): AsyncIterable<StoredEvent> {
    if (!Number.isSafeInteger(options.fromSeq) || options.fromSeq < 0) {
      throw new InvalidEventError([["fromSeq"]]);
    }
    if (
      options.maxBuffered !== undefined &&
      (!Number.isSafeInteger(options.maxBuffered) || options.maxBuffered < 1)
    ) {
      throw new InvalidEventError([["maxBuffered"]]);
    }
    const maxBuffered = options.maxBuffered ?? 1_000;
    let nextSeq = options.fromSeq;
    while (!options.signal.aborted) {
      let wake: () => void = () => undefined;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const unsubscribe = this.subscribeRun(runId, wake, options.signal);
      try {
        const head = await this.head(runId);
        const toSeq = Math.min(head - 1, nextSeq + maxBuffered - 1);
        for await (const event of this.read(runId, { fromSeq: nextSeq, toSeq })) {
          if (options.signal.aborted) {
            return;
          }
          nextSeq = event.seq + 1;
          yield event;
          if (
            event.type === "run_status_changed" &&
            ["completed", "failed", "cancelled"].includes(event.to)
          ) {
            return;
          }
        }
        if (nextSeq < head) {
          continue;
        }
        const stored = this.runs.get(runId);
        const last = stored?.at(-1);
        if (
          last?.type === "run_status_changed" &&
          ["completed", "failed", "cancelled"].includes(last.to) &&
          (stored?.length ?? 0) <= nextSeq
        ) {
          return;
        }
        await changed;
      } finally {
        unsubscribe();
      }
    }
  }

  private async allRunSummaries(): Promise<RunSummary[]> {
    const summaries = new Map<Id, RunSummary>();
    let cursor: string | undefined;
    do {
      const page = await this.listRuns({
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const summary of page.runs) {
        summaries.set(summary.runId, summary);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return [...summaries.values()];
  }

  /** {@inheritDoc EventStore.watchRuns} */
  async *watchRuns(options: WatchRunsOptions): AsyncIterable<RunSummary> {
    if (options.statuses?.some((status) => !RunStatus.safeParse(status).success)) {
      throw new InvalidEventError([["statuses"]]);
    }
    let seen = new Map<Id, RunSummary>();
    let initialized = false;
    while (!options.signal.aborted) {
      let wake: () => void = () => undefined;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const unsubscribe = this.subscribeRunList(wake, options.signal);
      try {
        const summaries = await this.allRunSummaries();
        if (!initialized) {
          for (const summary of summaries) {
            if (options.signal.aborted) {
              return;
            }
            if (options.statuses === undefined || options.statuses.includes(summary.status)) {
              yield summary;
            }
          }
          seen = new Map(summaries.map((summary) => [summary.runId, summary]));
          initialized = true;
        } else {
          for (const summary of summaries) {
            const previous = seen.get(summary.runId);
            if (previous === undefined) {
              for await (const event of this.read(summary.runId, {
                fromSeq: 0,
                toSeq: summary.lastSeq,
              })) {
                if (options.signal.aborted) {
                  return;
                }
                const status =
                  event.type === "run_created"
                    ? "pending"
                    : event.type === "run_status_changed"
                      ? event.to
                      : undefined;
                if (
                  status !== undefined &&
                  (options.statuses === undefined || options.statuses.includes(status))
                ) {
                  yield {
                    ...summary,
                    status,
                    lastSeq: event.seq,
                    lastTs: event.ts,
                  };
                }
              }
            } else if (summary.lastSeq > previous.lastSeq) {
              for await (const event of this.read(summary.runId, {
                fromSeq: previous.lastSeq + 1,
                toSeq: summary.lastSeq,
              })) {
                if (options.signal.aborted) {
                  return;
                }
                if (event.type === "run_status_changed") {
                  if (options.statuses === undefined || options.statuses.includes(event.to)) {
                    yield {
                      ...summary,
                      status: event.to,
                      lastSeq: event.seq,
                      lastTs: event.ts,
                    };
                  }
                }
              }
            }
            seen.set(summary.runId, summary);
          }
        }
        await changed;
      } finally {
        unsubscribe();
      }
    }
  }

  /** {@inheritDoc EventStore.head} */
  head(runId: Id): Promise<number> {
    return Promise.resolve(this.runs.get(runId)?.length ?? 0);
  }

  /** {@inheritDoc EventStore.deleteRun} */
  deleteRun(runId: Id): Promise<number> {
    const events = this.runs.get(runId);
    if (events === undefined) {
      return Promise.resolve(0);
    }
    let status: RunSummary["status"] = "pending";
    for (const event of events) {
      if (event.type === "run_status_changed") {
        status = event.to;
      }
    }
    if (status !== "completed" && status !== "failed" && status !== "cancelled") {
      return Promise.resolve(0);
    }

    this.runs.delete(runId);
    this.snapshots.delete(runId);
    for (const [approvalId, notification] of this.approvalNotifications) {
      if (notification.runId === runId) {
        this.approvalNotifications.delete(approvalId);
      }
    }
    for (let index = this.outboxEvents.length - 1; index >= 0; index -= 1) {
      if (this.outboxEvents[index]?.event.runId === runId) {
        this.outboxEvents.splice(index, 1);
      }
    }
    for (const [traceId, runs] of this.traceRuns) {
      runs.delete(runId);
      if (runs.size === 0) {
        this.traceRuns.delete(traceId);
      }
    }
    return Promise.resolve(events.length);
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
      if (!matchesContinuation(created, opts.continuationOf)) {
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

  /** {@inheritDoc EventStore.claimApprovalNotification} */
  claimApprovalNotification(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    leaseMs: number,
  ): Promise<boolean> {
    const current = this.approvalNotifications.get(approvalId);
    if (
      current !== undefined &&
      (current.runId !== runId ||
        current.sentAt !== undefined ||
        current.claimedAt > claimedAt - leaseMs)
    ) {
      return Promise.resolve(false);
    }
    this.approvalNotifications.set(approvalId, { runId, claimedAt });
    return Promise.resolve(true);
  }

  markApprovalNotificationSent(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    sentAt: number,
  ): Promise<boolean> {
    const current = this.approvalNotifications.get(approvalId);
    if (
      current?.runId !== runId ||
      current.claimedAt !== claimedAt ||
      current.sentAt !== undefined
    ) {
      return Promise.resolve(false);
    }
    this.approvalNotifications.set(approvalId, { runId, claimedAt, sentAt });
    return Promise.resolve(true);
  }

  /** {@inheritDoc EventStore.releaseApprovalNotification} */
  releaseApprovalNotification(approvalId: Id, runId: Id, claimedAt: number): Promise<void> {
    const current = this.approvalNotifications.get(approvalId);
    if (
      current?.runId === runId &&
      current.claimedAt === claimedAt &&
      current.sentAt === undefined
    ) {
      this.approvalNotifications.delete(approvalId);
    }
    return Promise.resolve();
  }

  /** {@inheritDoc EventStore.close} */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
