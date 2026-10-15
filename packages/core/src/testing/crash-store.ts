// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  type Code,
  type Event,
  type Id,
  type NewEvent,
  type Snapshot,
  type TraceId,
} from "@harness/schemas";
import type { EventStore, ListRunsOptions, RunSummary } from "@harness/store";

/** Error thrown at the selected append boundary. */
export class SimulatedCrash extends HarnessError {
  readonly code = "simulated_crash";

  /** Creates a simulated process crash. */
  constructor() {
    super("The process crashed at an event-store append boundary.");
    this.name = "SimulatedCrash";
  }
}

/** Failure point for a crashing store wrapper. */
export interface CrashingEventStoreOptions {
  readonly crashAt: number;
  readonly mode: "before_commit" | "after_commit";
}

/**
 * Injects one crash at a selected append boundary while delegating all store reads.
 *
 * @param inner - Store whose persisted state is retained across simulated restarts.
 * @param options - One-based append boundary and whether it crashes before or after commit.
 */
export class CrashingEventStore implements EventStore {
  private appendCount = 0;
  private crashed = false;

  constructor(
    private readonly inner: EventStore,
    private readonly options: CrashingEventStoreOptions,
  ) {
    if (!Number.isSafeInteger(options.crashAt) || options.crashAt < 1) {
      throw new RangeError("Crash point must be a positive safe integer.");
    }
  }

  /** Number of append and appendWithSnapshot calls observed so far. */
  get appendCalls(): number {
    return this.appendCount;
  }

  append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
  ): Promise<{ nextSeq: number }> {
    const shouldCrash = this.shouldCrash();
    if (shouldCrash && this.options.mode === "before_commit") {
      return Promise.reject(new SimulatedCrash());
    }
    const result = this.inner.append(runId, events, expectedSeq);
    return shouldCrash ? result.then(() => Promise.reject(new SimulatedCrash())) : result;
  }

  appendWithSnapshot(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Snapshot,
  ): Promise<{ nextSeq: number }> {
    const shouldCrash = this.shouldCrash();
    if (shouldCrash && this.options.mode === "before_commit") {
      return Promise.reject(new SimulatedCrash());
    }
    const result = this.inner.appendWithSnapshot(runId, events, expectedSeq, snapshot);
    return shouldCrash ? result.then(() => Promise.reject(new SimulatedCrash())) : result;
  }

  latestSnapshot(runId: Id): Promise<Snapshot | undefined> {
    return this.inner.latestSnapshot(runId);
  }

  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<Event> {
    return this.inner.read(runId, range);
  }

  watch(...args: Parameters<EventStore["watch"]>): ReturnType<EventStore["watch"]> {
    return this.inner.watch(...args);
  }

  watchRuns(...args: Parameters<EventStore["watchRuns"]>): ReturnType<EventStore["watchRuns"]> {
    return this.inner.watchRuns(...args);
  }

  head(runId: Id): Promise<number> {
    return this.inner.head(runId);
  }

  deleteRun(runId: Id): Promise<number> {
    return this.inner.deleteRun(runId);
  }

  consumeConfirmationState(stateId: string, expiresAt: number, now: number): Promise<boolean> {
    return this.inner.consumeConfirmationState(stateId, expiresAt, now);
  }

  claimIdempotencyKey(
    keyHash: Parameters<EventStore["claimIdempotencyKey"]>[0],
    runId: Id,
    createdAt: number,
  ): Promise<Id> {
    return this.inner.claimIdempotencyKey(keyHash, runId, createdAt);
  }

  takeoverIdempotencyKey(
    ...args: Parameters<EventStore["takeoverIdempotencyKey"]>
  ): ReturnType<EventStore["takeoverIdempotencyKey"]> {
    return this.inner.takeoverIdempotencyKey(...args);
  }

  releaseIdempotencyKey(
    keyHash: Parameters<EventStore["releaseIdempotencyKey"]>[0],
    runId: Id,
  ): Promise<void> {
    return this.inner.releaseIdempotencyKey(keyHash, runId);
  }

  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    return this.inner.listRuns(opts);
  }

  findRunsByTrace(traceId: TraceId): Promise<Id[]> {
    return this.inner.findRunsByTrace(traceId);
  }

  fetchOutbox(sinkId: Code, limit: number): Promise<{ events: Event[]; cursor: number }> {
    return this.inner.fetchOutbox(sinkId, limit);
  }

  ackOutbox(sinkId: Code, cursor: number): Promise<void> {
    return this.inner.ackOutbox(sinkId, cursor);
  }

  claimApprovalNotification(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    leaseMs: number,
  ): Promise<boolean> {
    return this.inner.claimApprovalNotification(approvalId, runId, claimedAt, leaseMs);
  }

  markApprovalNotificationSent(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    sentAt: number,
  ): Promise<boolean> {
    return this.inner.markApprovalNotificationSent(approvalId, runId, claimedAt, sentAt);
  }

  releaseApprovalNotification(approvalId: Id, runId: Id, claimedAt: number): Promise<void> {
    return this.inner.releaseApprovalNotification(approvalId, runId, claimedAt);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  private shouldCrash(): boolean {
    this.appendCount += 1;
    if (this.crashed || this.appendCount !== this.options.crashAt) {
      return false;
    }
    this.crashed = true;
    return true;
  }
}
