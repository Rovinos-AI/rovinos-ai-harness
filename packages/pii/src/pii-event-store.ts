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
  type Snapshot,
  type Code,
  type TraceId,
} from "@harness/schemas";
import type { EventStore, ListRunsOptions, RunSummary } from "@harness/store";
import { PiiStorageFailedError } from "./errors.js";
import type { Tokenizer } from "./tokenizer.js";

const sanitized = new WeakSet();

/** Marks an event or object-valued content field as already sanitized. */
export function markSanitized<T extends WeakKey>(value: T): T {
  sanitized.add(value);
  return value;
}

/** Tokenizes classified event content and snapshot values before they reach storage. */
export class PiiEventStore implements EventStore {
  /**
   * Wraps an event store with storage-boundary content sanitization.
   *
   * @param inner - Store that receives sanitized events and snapshots.
   * @param tokenizer - Tokenizer used only for unmarked content.
   * @param onSummary - Receives metadata-only summaries before the append is attempted.
   */
  constructor(
    private readonly inner: EventStore,
    private readonly tokenizer: Tokenizer,
    private readonly onSummary: (summary: PiiActionSummary) => void | Promise<void> = () =>
      Promise.resolve(),
  ) {}

  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
  ): Promise<{ nextSeq: number }> {
    const prepared = await this.prepareEvents(runId, events, expectedSeq);
    await this.notifySummaries(prepared.summaries);
    return this.inner.append(runId, prepared.events, expectedSeq);
  }

  async appendWithSnapshot(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Snapshot,
  ): Promise<{ nextSeq: number }> {
    const prepared = await this.prepareEvents(runId, events, expectedSeq);
    let sanitizedSnapshot: Snapshot;
    let snapshotSummaries: readonly PiiActionSummary[];
    try {
      const context = isMarked(snapshot)
        ? { value: snapshot.context, actions: [] }
        : await this.sanitizeJson(runId, snapshot.context);
      const plan = isMarked(snapshot)
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
    return this.inner.appendWithSnapshot(runId, prepared.events, expectedSeq, sanitizedSnapshot);
  }

  latestSnapshot(runId: Id): Promise<Snapshot | undefined> {
    return this.inner.latestSnapshot(runId);
  }

  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<Event> {
    return this.inner.read(runId, range);
  }

  head(runId: Id): Promise<number> {
    return this.inner.head(runId);
  }

  deleteRun(runId: Id): Promise<number> {
    return this.inner.deleteRun(runId);
  }

  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    return this.inner.listRuns(opts);
  }

  findRunsByTrace(traceId: TraceId): Promise<Id[]> {
    return this.inner.findRunsByTrace(traceId);
  }

  fetchOutbox(sinkId: Code, limit: number): ReturnType<EventStore["fetchOutbox"]> {
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
      if (sanitized.has(source)) {
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
        Object.entries(content).filter(([key]) => !isMarked(Reflect.get(source, key))),
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
        const sanitizedContent = asJsonObject(result.value);
        summaries.push(...result.actions);
        if (Object.keys(sanitizedContent).length === 0) {
          prepared.push(source);
          continue;
        }
        const event = joinEvent(meta, { ...content, ...sanitizedContent });
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

function isMarked(value: unknown): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? sanitized.has(value)
    : false;
}

function asJsonObject(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PiiStorageFailedError();
  }
  return value;
}
