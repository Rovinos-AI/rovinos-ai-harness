// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  type Id,
  type TraceId,
  type Event as StoredEvent,
  type NewEvent,
  type Snapshot,
} from "@rovinos/schemas";
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
  UsageLedgerPeriodSchema,
  UsageLedgerRowSchema,
  parseUsageLedgerDeltas,
  type UsageLedgerDelta,
  type UsageLedgerPeriod,
  type UsageLedgerRow,
} from "./types.js";
import { z } from "zod";
import {
  ChangeEmitter,
  summaryFromEvents,
  watchEvents,
  watchRunSummaries,
} from "./subscriptions.js";
import {
  hasDuplicateSnapshot,
  listMemoryRunsSafely,
  validateEventBatch,
} from "./memory-helpers.js";
import { MemoryStoreAuxiliary } from "./memory-auxiliary.js";
import { memoryUsageLedgerKey, stageMemoryUsageUpdates } from "./memory-usage.js";

/** In-memory reference implementation of the append-only event store contract. */
export class InMemoryEventStore implements EventStore {
  private readonly runs = new Map<Id, StoredEvent[]>();
  private readonly changeEmitter = new ChangeEmitter();
  private readonly snapshots = new Map<Id, EncodedSnapshot[]>();
  private readonly auxiliary = new MemoryStoreAuxiliary();
  private readonly executionLeases = new Map<Id, { readonly owner: Id; expiresAt: number }>();
  private readonly usageLedger = new Map<string, UsageLedgerRow>();
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

  /** {@inheritDoc EventStore.appendWithUsage} */
  appendWithUsage(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    options: Parameters<EventStore["appendWithUsage"]>[3],
  ): Promise<{ nextSeq: number }> {
    try {
      const { usageUpdates, leaseOwner } = options;
      return Promise.resolve(
        this.appendEvents({
          runId,
          events,
          expectedSeq,
          usageUpdates: parseUsageLedgerDeltas(usageUpdates),
          ...(leaseOwner === undefined ? {} : { leaseOwner }),
        }),
      );
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new StoreUnavailableError());
    }
  }

  /** {@inheritDoc EventStore.readUsageLedger} */
  readUsageLedger(
    quotaId: Code,
    period: UsageLedgerPeriod,
    periodStarts: readonly number[],
  ): Promise<UsageLedgerRow[]> {
    const parsedQuotaId = Code.safeParse(quotaId);
    const parsedPeriod = UsageLedgerPeriodSchema.safeParse(period);
    const periods = z.array(z.number().int().nonnegative()).parse(periodStarts);
    if (!parsedQuotaId.success || !parsedPeriod.success) {
      return Promise.reject(new InvalidEventError([["quotaId"]]));
    }
    return Promise.resolve(
      periods.flatMap((periodStart) => {
        const row = this.usageLedger.get(
          memoryUsageLedgerKey({
            quotaId: parsedQuotaId.data,
            period: parsedPeriod.data,
            periodStart,
            costMicros: 0,
            runsStarted: 0,
          }),
        );
        return row === undefined ? [] : [UsageLedgerRowSchema.parse(row)];
      }),
    );
  }

  private appendEvents(options: {
    readonly runId: Id;
    readonly events: readonly NewEvent[];
    readonly expectedSeq: number;
    readonly encodedSnapshot?: EncodedSnapshot;
    readonly usageUpdates?: readonly UsageLedgerDelta[];
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

    const updatedUsage = stageMemoryUsageUpdates({
      ledger: this.usageLedger,
      updates: options.usageUpdates ?? [],
    });

    this.runs.set(runId, [...stored, ...validated]);
    for (const [key, row] of updatedUsage) {
      this.usageLedger.set(key, row);
    }
    this.auxiliary.recordTraceRuns(runId, validated);
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
    this.auxiliary.deleteRun(runId);
    return Promise.resolve(events.length);
  }

  /** {@inheritDoc EventStore.listRuns} */
  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    return listMemoryRunsSafely(this.runs, opts);
  }

  /** {@inheritDoc EventStore.findRunsByTrace} */
  findRunsByTrace(traceId: TraceId): Promise<Id[]> {
    return this.auxiliary.findRunsByTrace(traceId);
  }

  /** {@inheritDoc EventStore.fetchOutbox} */
  fetchOutbox(sinkId: Code, limit: number): Promise<{ events: StoredEvent[]; cursor: number }> {
    return this.auxiliary.fetchOutbox(sinkId, limit);
  }

  /** {@inheritDoc EventStore.ackOutbox} */
  ackOutbox(sinkId: Code, cursor: number): Promise<void> {
    return this.auxiliary.ackOutbox(sinkId, cursor);
  }

  /** {@inheritDoc EventStore.claimApprovalNotification} */
  claimApprovalNotification(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    leaseMs: number,
  ): Promise<boolean> {
    return this.auxiliary.claimApprovalNotification(approvalId, runId, claimedAt, leaseMs);
  }

  markApprovalNotificationSent(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    sentAt: number,
  ): Promise<boolean> {
    return this.auxiliary.markApprovalNotificationSent(approvalId, runId, claimedAt, sentAt);
  }

  /** {@inheritDoc EventStore.releaseApprovalNotification} */
  releaseApprovalNotification(approvalId: Id, runId: Id, claimedAt: number): Promise<void> {
    return this.auxiliary.releaseApprovalNotification(approvalId, runId, claimedAt);
  }

  /** {@inheritDoc EventStore.consumeConfirmationState} */
  consumeConfirmationState(stateId: string, expiresAt: number, now: number): Promise<boolean> {
    return this.auxiliary.consumeConfirmationState(stateId, expiresAt, now);
  }

  /** {@inheritDoc EventStore.claimIdempotencyKey} */
  claimIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id, createdAt: number): Promise<Id> {
    return this.auxiliary.claimIdempotencyKey(keyHash, runId, createdAt);
  }

  /** {@inheritDoc EventStore.takeoverIdempotencyKey} */
  takeoverIdempotencyKey(
    keyHash: IdempotencyKeyHash,
    options: Parameters<EventStore["takeoverIdempotencyKey"]>[1],
  ): Promise<boolean> {
    return this.auxiliary.takeoverIdempotencyKey(keyHash, options, this.runs);
  }

  /** {@inheritDoc EventStore.releaseIdempotencyKey} */
  releaseIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id): Promise<void> {
    return this.auxiliary.releaseIdempotencyKey(keyHash, runId);
  }

  /** {@inheritDoc EventStore.close} */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
