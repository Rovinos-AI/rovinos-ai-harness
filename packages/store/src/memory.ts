// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  type Id,
  TraceId,
  type Event as StoredEvent,
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
import {
  InvalidEventError,
  RunExecutionLeaseLostError,
  SeqConflictError,
  StoreUnavailableError,
} from "./errors.js";
import {
  type EventStore,
  type ListRunsOptions,
  type IdempotencyKeyHash,
  type RunSummary,
  type SnapshotStoreOptions,
} from "./types.js";
import {
  claimMemoryIdempotencyKey,
  deleteMemoryIdempotencyKeyClaims,
  releaseMemoryIdempotencyKey,
  takeoverMemoryIdempotencyKey,
  type MemoryIdempotencyClaim,
} from "./idempotency.js";
import {
  ChangeEmitter,
  summaryFromEvents,
  watchEvents,
  watchRunSummaries,
} from "./subscriptions.js";
import {
  hasDuplicateSnapshot,
  listMemoryRuns,
  validateEventBatch,
} from "./memory-helpers.js";

/** In-memory reference implementation of the append-only event store contract. */
export class InMemoryEventStore implements EventStore {
  private readonly runs = new Map<Id, StoredEvent[]>();
  private readonly changeEmitter = new ChangeEmitter();
  private readonly traceRuns = new Map<TraceId, Map<Id, number>>();
  private readonly snapshots = new Map<Id, EncodedSnapshot[]>();
  private readonly outboxEvents: { globalSeq: number; event: StoredEvent }[] = [];
  private readonly sinkCursors = new Map<string, number>();
  private readonly approvalNotifications = new Map<
    Id,
    { readonly runId: Id; readonly claimedAt: number; readonly sentAt?: number }
  >();
  private readonly confirmationStates = new Map<string, number>();
  private readonly idempotencyKeys = new Map<string, MemoryIdempotencyClaim>();
  private readonly executionLeases = new Map<Id, { readonly owner: Id; expiresAt: number }>();
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
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    try {
      return Promise.resolve(
        this.appendEvents({
          runId,
          events,
          expectedSeq,
          ...(leaseOwner === undefined ? {} : { leaseOwner }),
        }),
      );
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new StoreUnavailableError());
    }
  }

  /** {@inheritDoc EventStore.appendWithSnapshot} */
  async appendWithSnapshot(
    ...args: Parameters<EventStore["appendWithSnapshot"]>
  ): Promise<{ nextSeq: number }> {
    const [runId, events, expectedSeq, snapshot, leaseOwner] = args;
    try {
      const validatedSnapshot = validateSnapshotAppend(runId, events, expectedSeq, snapshot);
      const encodedSnapshot = await encodeSnapshot(this.codec, validatedSnapshot);
      return this.appendEvents({
        runId,
        events,
        expectedSeq,
        encodedSnapshot,
        ...(leaseOwner === undefined ? {} : { leaseOwner }),
      });
    } catch (error) {
      throw error instanceof Error ? error : new StoreUnavailableError();
    }
  }

  private appendEvents(options: {
    readonly runId: Id;
    readonly events: readonly NewEvent[];
    readonly expectedSeq: number;
    readonly encodedSnapshot?: EncodedSnapshot;
    readonly leaseOwner?: Id;
  }): { nextSeq: number } {
    const { runId, events, expectedSeq, encodedSnapshot, leaseOwner } = options;
    if (leaseOwner !== undefined && this.executionLeases.get(runId)?.owner !== leaseOwner) {
      throw new RunExecutionLeaseLostError();
    }
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
    this.changeEmitter.notify(runId);
    return { nextSeq: expectedSeq + validated.length };
  }

  /** {@inheritDoc EventStore.claimRunExecution} */
  claimRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    const existing = this.executionLeases.get(runId);
    if (existing !== undefined && existing.expiresAt > now) {
      return Promise.resolve(false);
    }
    this.executionLeases.set(runId, { owner, expiresAt: now + leaseMs });
    return Promise.resolve(true);
  }

  /** {@inheritDoc EventStore.renewRunExecution} */
  renewRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    const existing = this.executionLeases.get(runId);
    if (existing?.owner !== owner || existing.expiresAt <= now) {
      return Promise.resolve(false);
    }
    this.executionLeases.set(runId, { owner, expiresAt: now + leaseMs });
    return Promise.resolve(true);
  }

  /** {@inheritDoc EventStore.releaseRunExecution} */
  releaseRunExecution(runId: Id, owner: Id): Promise<void> {
    if (this.executionLeases.get(runId)?.owner === owner) {
      this.executionLeases.delete(runId);
    }
    return Promise.resolve();
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

  /** {@inheritDoc EventStore.retainedSnapshots} */
  async retainedSnapshots(runId: Id, limit: number): Promise<Snapshot[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("Snapshot limit must be a positive integer");
    }
    return Promise.all(
      (this.snapshots.get(runId) ?? [])
        .slice(0, limit)
        .map((snapshot) => decodeSnapshot(this.codec, snapshot)),
    );
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
  watch(runId: Id, options: Parameters<EventStore["watch"]>[1]): AsyncIterable<StoredEvent> {
    return watchEvents(this, runId, options, {
      subscribe: (watchedRunId, signal) => this.changeEmitter.subscribe(watchedRunId, signal),
      isTerminal: (watchedRunId, observedNextSeq) => {
        const stored = this.runs.get(watchedRunId);
        const last = stored?.at(-1);
        return Promise.resolve(
          stored !== undefined &&
            stored.length <= observedNextSeq &&
            last?.type === "run_status_changed" &&
            ["completed", "failed", "cancelled"].includes(last.to),
        );
      },
    });
  }

  /** {@inheritDoc EventStore.watchRuns} */
  watchRuns(options: Parameters<EventStore["watchRuns"]>[0]): AsyncIterable<RunSummary> {
    return watchRunSummaries(
      this,
      options,
      (runId, signal) => this.changeEmitter.subscribe(runId, signal),
      (runId) => Promise.resolve(summaryFromEvents(runId, this.runs.get(runId))),
    );
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
    this.executionLeases.delete(runId);
    deleteMemoryIdempotencyKeyClaims(this.idempotencyKeys, runId);
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
    return Promise.resolve().then(() => listMemoryRuns(this.runs, opts));
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

  /** {@inheritDoc EventStore.consumeConfirmationState} */
  consumeConfirmationState(stateId: string, expiresAt: number, now: number): Promise<boolean> {
    for (const [consumedStateId, consumedExpiry] of this.confirmationStates) {
      if (consumedExpiry <= now) {
        this.confirmationStates.delete(consumedStateId);
      }
    }
    if (this.confirmationStates.has(stateId)) {
      return Promise.resolve(false);
    }
    this.confirmationStates.set(stateId, expiresAt);
    return Promise.resolve(true);
  }

  /** {@inheritDoc EventStore.claimIdempotencyKey} */
  claimIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id, createdAt: number): Promise<Id> {
    return claimMemoryIdempotencyKey(this.idempotencyKeys, keyHash, runId, createdAt);
  }

  /** {@inheritDoc EventStore.takeoverIdempotencyKey} */
  takeoverIdempotencyKey(
    keyHash: IdempotencyKeyHash,
    options: Parameters<EventStore["takeoverIdempotencyKey"]>[1],
  ): Promise<boolean> {
    return Promise.resolve().then(() =>
      takeoverMemoryIdempotencyKey(this.idempotencyKeys, this.runs, keyHash, options),
    );
  }

  /** {@inheritDoc EventStore.releaseIdempotencyKey} */
  releaseIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id): Promise<void> {
    return releaseMemoryIdempotencyKey(this.idempotencyKeys, keyHash, runId);
  }

  /** {@inheritDoc EventStore.close} */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
