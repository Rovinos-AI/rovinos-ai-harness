// SPDX-License-Identifier: Apache-2.0
import {
  EventSchema,
  JsonValue as JsonValueSchema,
  joinEvent,
  splitEvent,
  type Event,
  type Id,
  type JsonValue,
  type NewEvent,
  type PiiActionSummary,
  type RunStatus,
  type Snapshot,
  type Code,
  type TraceId,
} from "@rovinos/schemas";
import { storedModelRequestHash } from "@rovinos/schemas/request-signature";
import { PiiStorageFailedError } from "./errors.js";
import type { Tokenizer } from "./tokenizer.js";
import { isMarked } from "./sanitization-markers.js";

export { isSanitizedField, markSanitized, markSanitizedField } from "./sanitization-markers.js";

interface RunSummaryLike {
  readonly runId: Id;
  readonly createdAt: number;
  readonly status: RunStatus;
  readonly lastSeq: number;
  readonly lastTs: number;
}

interface ListRunsOptionsLike {
  readonly status?: RunStatus;
  readonly continuationOf?: Id;
  readonly limit: number;
  readonly cursor?: string;
}

interface WatchOptionsLike {
  readonly fromSeq: number;
  readonly signal: AbortSignal;
  readonly maxBuffered?: number;
}

interface WatchRunsOptionsLike {
  readonly statuses?: readonly RunStatus[];
  readonly signal: AbortSignal;
}

interface UsageLedgerDeltaLike {
  readonly quotaId: Code;
  readonly period: "hour" | "day" | "month";
  readonly periodStart: number;
  readonly costMicros: number;
  readonly runsStarted: number;
  readonly maxRunsStarted?: number;
}

interface UsageLedgerRowLike {
  readonly quotaId: Code;
  readonly period: "hour" | "day" | "month";
  readonly periodStart: number;
  readonly costMicros: number;
  readonly runsStarted: number;
}

/** Structural event-store contract implemented by the wrapped store. */
export interface EventStoreLike {
  append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }>;
  appendWithSnapshot(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Snapshot,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }>;
  appendWithUsage(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    options: { readonly usageUpdates: readonly UsageLedgerDeltaLike[]; readonly leaseOwner?: Id },
  ): Promise<{ nextSeq: number }>;
  readUsageLedger(
    quotaId: Code,
    period: UsageLedgerDeltaLike["period"],
    periodStarts: readonly number[],
  ): Promise<UsageLedgerRowLike[]>;
  claimRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean>;
  renewRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean>;
  releaseRunExecution(runId: Id, owner: Id): Promise<void>;
  latestSnapshot(runId: Id): Promise<Snapshot | undefined>;
  retainedSnapshots(runId: Id, limit: number): Promise<Snapshot[]>;
  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<Event>;
  watch(runId: Id, options: WatchOptionsLike): AsyncIterable<Event>;
  watchRuns(options: WatchRunsOptionsLike): AsyncIterable<RunSummaryLike>;
  head(runId: Id): Promise<number>;
  deleteRun(runId: Id): Promise<number>;
  consumeConfirmationState(stateId: string, expiresAt: number, now: number): Promise<boolean>;
  claimIdempotencyKey(keyHash: string, runId: Id, createdAt: number): Promise<Id>;
  takeoverIdempotencyKey(
    keyHash: string,
    options: {
      readonly expectedRunId: Id;
      readonly runId: Id;
      readonly createdAt: number;
      readonly staleBefore: number;
    },
  ): Promise<boolean>;
  releaseIdempotencyKey(keyHash: string, runId: Id): Promise<void>;
  listRuns(opts: ListRunsOptionsLike): Promise<{ runs: RunSummaryLike[]; nextCursor?: string }>;
  findRunsByTrace(traceId: TraceId): Promise<Id[]>;
  fetchOutbox(sinkId: Code, limit: number): Promise<{ events: Event[]; cursor: number }>;
  ackOutbox(sinkId: Code, cursor: number): Promise<void>;
  claimApprovalNotification(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    leaseMs: number,
  ): Promise<boolean>;
  markApprovalNotificationSent(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    sentAt: number,
  ): Promise<boolean>;
  releaseApprovalNotification(approvalId: Id, runId: Id, claimedAt: number): Promise<void>;
  close(): Promise<void>;
}

/** Tokenizes classified event content and snapshot values before they reach storage. */
export class PiiEventStore implements EventStoreLike {
  /**
   * Wraps an event store with storage-boundary content sanitization.
   *
   * @param inner - Store that receives sanitized events and snapshots.
   * @param tokenizer - Tokenizer used only for unmarked content.
   * @param onSummary - Receives metadata-only summaries before the append is attempted.
   */
  constructor(
    private readonly inner: EventStoreLike,
    private readonly tokenizer: Tokenizer,
    private readonly onSummary: (summary: PiiActionSummary) => void | Promise<void> = () =>
      Promise.resolve(),
  ) {}

  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    const prepared = await this.prepareEvents(runId, events, expectedSeq);
    await this.notifySummaries(prepared.summaries);
    return this.inner.append(runId, prepared.events, expectedSeq, leaseOwner);
  }

  async appendWithSnapshot(
    ...args: Parameters<EventStoreLike["appendWithSnapshot"]>
  ): Promise<{ nextSeq: number }> {
    const [runId, events, expectedSeq, snapshot, leaseOwner] = args;
    const prepared = await this.prepareEvents(runId, events, expectedSeq);
    let sanitizedSnapshot: Snapshot;
    let snapshotSummaries: readonly PiiActionSummary[];
    try {
      const context = isMarked(snapshot, "context")
        ? { value: snapshot.context, actions: [] }
        : await this.sanitizeJson(runId, snapshot.context);
      const plan = isMarked(snapshot, "plan")
        ? { value: snapshot.plan, actions: [] }
        : await this.sanitizeJson(runId, snapshot.plan);
      sanitizedSnapshot =
        context.value === snapshot.context && plan.value === snapshot.plan
          ? snapshot
          : { ...snapshot, context: context.value, plan: plan.value };
      snapshotSummaries = [...context.actions, ...plan.actions];
      await this.notifySummaries([...prepared.summaries, ...snapshotSummaries]);
    } catch {
      throw new PiiStorageFailedError();
    }
    return this.inner.appendWithSnapshot(
      runId,
      prepared.events,
      expectedSeq,
      sanitizedSnapshot,
      leaseOwner,
    );
  }

  async appendWithUsage(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    options: { readonly usageUpdates: readonly UsageLedgerDeltaLike[]; readonly leaseOwner?: Id },
  ): Promise<{ nextSeq: number }> {
    const prepared = await this.prepareEvents(runId, events, expectedSeq);
    await this.notifySummaries(prepared.summaries);
    return this.inner.appendWithUsage(runId, prepared.events, expectedSeq, options);
  }

  readUsageLedger(
    quotaId: Code,
    period: UsageLedgerDeltaLike["period"],
    periodStarts: readonly number[],
  ): Promise<UsageLedgerRowLike[]> {
    return this.inner.readUsageLedger(quotaId, period, periodStarts);
  }

  latestSnapshot(runId: Id): Promise<Snapshot | undefined> {
    return this.inner.latestSnapshot(runId);
  }

  retainedSnapshots(runId: Id, limit: number): Promise<Snapshot[]> {
    return this.inner.retainedSnapshots(runId, limit);
  }

  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<Event> {
    return this.inner.read(runId, range);
  }

  watch(runId: Id, options: WatchOptionsLike): AsyncIterable<Event> {
    return this.inner.watch(runId, options);
  }

  watchRuns(options: WatchRunsOptionsLike): AsyncIterable<RunSummaryLike> {
    return this.inner.watchRuns(options);
  }

  head(runId: Id): Promise<number> {
    return this.inner.head(runId);
  }

  claimRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    return this.inner.claimRunExecution(runId, owner, now, leaseMs);
  }

  renewRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    return this.inner.renewRunExecution(runId, owner, now, leaseMs);
  }

  releaseRunExecution(runId: Id, owner: Id): Promise<void> {
    return this.inner.releaseRunExecution(runId, owner);
  }

  deleteRun(runId: Id): Promise<number> {
    return this.inner.deleteRun(runId);
  }

  consumeConfirmationState(stateId: string, expiresAt: number, now: number): Promise<boolean> {
    return this.inner.consumeConfirmationState(stateId, expiresAt, now);
  }

  claimIdempotencyKey(keyHash: string, runId: Id, createdAt: number): Promise<Id> {
    return this.inner.claimIdempotencyKey(keyHash, runId, createdAt);
  }

  takeoverIdempotencyKey(
    keyHash: string,
    options: {
      readonly expectedRunId: Id;
      readonly runId: Id;
      readonly createdAt: number;
      readonly staleBefore: number;
    },
  ): Promise<boolean> {
    return this.inner.takeoverIdempotencyKey(keyHash, options);
  }

  releaseIdempotencyKey(keyHash: string, runId: Id): Promise<void> {
    return this.inner.releaseIdempotencyKey(keyHash, runId);
  }

  listRuns(opts: ListRunsOptionsLike): Promise<{ runs: RunSummaryLike[]; nextCursor?: string }> {
    return this.inner.listRuns(opts);
  }

  findRunsByTrace(traceId: TraceId): Promise<Id[]> {
    return this.inner.findRunsByTrace(traceId);
  }

  fetchOutbox(sinkId: Code, limit: number): ReturnType<EventStoreLike["fetchOutbox"]> {
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

  private async prepareEvents(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
  ): Promise<{
    readonly events: readonly NewEvent[];
    readonly summaries: readonly PiiActionSummary[];
  }> {
    const prepared: NewEvent[] = [];
    const summaries: PiiActionSummary[] = [];
    for (const [index, source] of events.entries()) {
      if (isMarked(source)) {
        prepared.push(source);
        continue;
      }
      const parsed = EventSchema.safeParse({ ...source, seq: expectedSeq + index });
      if (!parsed.success) {
        prepared.push(source);
        continue;
      }
      const { meta, content } = splitEvent(parsed.data);
      const unmarkedContent = Object.fromEntries(
        Object.entries(content).filter(([key]) => !isMarked(source, key)),
      );
      if (Object.keys(unmarkedContent).length === 0) {
        prepared.push(source);
        continue;
      }

      try {
        const contentValue = JsonValueSchema.parse(unmarkedContent);
        const result = await this.tokenizer.tokenizeJson(runId, contentValue, {
          boundary: "storage",
          destination: "any",
        });
        if (result.actions.some(({ action }) => action === "allow")) {
          throw new PiiStorageFailedError();
        }
        if (
          typeof result.value !== "object" ||
          result.value === null ||
          Array.isArray(result.value)
        ) {
          throw new PiiStorageFailedError();
        }
        const sanitizedContent = result.value;
        summaries.push(...result.actions);
        if (Object.keys(sanitizedContent).length === 0) {
          prepared.push(source);
          continue;
        }
        const event = joinEvent(meta, { ...content, ...sanitizedContent });
        if (
          event.type === "model_request" &&
          event.requestParametersHash !== undefined &&
          event.requestParametersHash !== null
        ) {
          event.requestHash = storedModelRequestHash(event.messages, event.requestParametersHash);
        }
        const { seq, ...newEvent } = event;
        if (seq !== expectedSeq + index) {
          throw new PiiStorageFailedError();
        }
        prepared.push(newEvent);
      } catch {
        throw new PiiStorageFailedError();
      }
    }
    return { events: prepared, summaries };
  }

  private async sanitizeJson(
    runId: Id,
    value: JsonValue,
  ): Promise<{ value: JsonValue; actions: readonly PiiActionSummary[] }> {
    if (isMarked(value)) {
      return { value, actions: [] };
    }
    const result = await this.tokenizer.tokenizeJson(runId, value, {
      boundary: "storage",
      destination: "any",
    });
    if (result.actions.some(({ action }) => action === "allow")) {
      throw new PiiStorageFailedError();
    }
    return result;
  }

  private async notifySummaries(summaries: readonly PiiActionSummary[]): Promise<void> {
    for (const summary of summaries) {
      try {
        await this.onSummary(summary);
      } catch {
        throw new PiiStorageFailedError();
      }
    }
  }
}
