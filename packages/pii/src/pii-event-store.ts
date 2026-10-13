// SPDX-License-Identifier: Apache-2.0
import {
  EventSchema,
  JsonValue as JsonValueSchema,
  joinEvent,
  splitEvent,
  toPiiActionEventPayload,
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

const sanitized = new WeakSet<object>();

/** Marks an event or object-valued content field as already sanitized. */
export function markSanitized<T extends object>(value: T): T {
  sanitized.add(value);
  return value;
}

/** Tokenizes classified event content and snapshot values before they reach storage. */
export class PiiEventStore implements EventStore {
  constructor(
    private readonly inner: EventStore,
    private readonly tokenizer: Tokenizer,
    private readonly onSummary: (summary: PiiActionSummary) => void | Promise<void> = () => {},
  ) {}

  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
  ): Promise<{ nextSeq: number }> {
    const prepared = await this.prepareEvents(runId, events, expectedSeq);
    const appended = await this.inner.append(runId, prepared.events, expectedSeq);
    return { nextSeq: await this.appendSummaries(prepared.summaries, appended.nextSeq) };
  }

  async appendWithSnapshot(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Snapshot,
  ): Promise<{ nextSeq: number }> {
    const prepared = await this.prepareEvents(runId, events, expectedSeq);
    let sanitizedSnapshot: Snapshot;
    let snapshotSummaries: readonly { source: NewEvent; summary: PiiActionSummary }[];
    try {
      const context = await this.sanitizeJson(runId, snapshot.context);
      const plan = await this.sanitizeJson(runId, snapshot.plan);
      sanitizedSnapshot = { ...snapshot, context: context.value, plan: plan.value };
      const source = prepared.events.find((event) => event.type === "checkpoint_written");
      snapshotSummaries = source === undefined
        ? []
        : [...context.actions, ...plan.actions].map((summary) => ({ source, summary }));
      await this.notifySummaries(snapshotSummaries);
    } catch {
      throw new PiiStorageFailedError();
    }
    const appended = await this.inner.appendWithSnapshot(
      runId,
      prepared.events,
      expectedSeq,
      sanitizedSnapshot,
    );
    const nextSeq = await this.appendSummaries(
      [...prepared.summaries, ...snapshotSummaries],
      appended.nextSeq,
    );
    return { nextSeq };
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

  listRuns(
    opts: ListRunsOptions,
  ): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
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
    readonly summaries: readonly { source: NewEvent; summary: PiiActionSummary }[];
  }> {
    const prepared: NewEvent[] = [];
    const summaries: { source: NewEvent; summary: PiiActionSummary }[] = [];
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
        for (const summary of result.actions) {
          const entry = { source, summary };
          summaries.push(entry);
        }
        if (Object.keys(sanitizedContent).length === 0) {
          prepared.push(source);
          continue;
        }
        const event = joinEvent(meta, { ...content, ...sanitizedContent });
        const { seq, ...newEvent } = event;
        void seq;
        prepared.push(newEvent);
      } catch {
        throw new PiiStorageFailedError();
      }
    }
    await this.notifySummaries(summaries);
    return { events: prepared, summaries };
  }

  private async sanitizeJson(
    runId: Id,
    value: JsonValue,
  ): Promise<{ value: JsonValue; summaries: readonly PiiActionSummary[] }> {
    if (isMarked(value)) {
      return { value, summaries: [] };
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

  private async notifySummaries(
    summaries: readonly { source: NewEvent; summary: PiiActionSummary }[],
  ): Promise<void> {
    for (const { summary } of summaries) {
      await this.onSummary(summary);
    }
  }

  private async appendSummaries(
    summaries: readonly { source: NewEvent; summary: PiiActionSummary }[],
    expectedSeq: number,
  ): Promise<number> {
    if (summaries.length === 0) {
      return expectedSeq;
    }
    const events = summaries.map(({ source, summary }) => storageActionEvent(source, summary));
    const firstEvent = events[0];
    if (firstEvent === undefined) {
      throw new PiiStorageFailedError();
    }
    return (await this.inner.append(firstEvent.runId, events, expectedSeq)).nextSeq;
  }
}

function isMarked(value: unknown): value is object {
  return typeof value === "object" && value !== null && sanitized.has(value);
}

function asJsonObject(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PiiStorageFailedError();
  }
  return value;
}

function storageActionEvent(source: NewEvent, summary: PiiActionSummary): NewEvent {
  return {
    runId: source.runId,
    ts: source.ts,
    v: source.v,
    traceId: source.traceId,
    spanId: source.spanId,
    segmentId: source.segmentId,
    type: "pii_action",
    ...toPiiActionEventPayload(summary),
  };
}
