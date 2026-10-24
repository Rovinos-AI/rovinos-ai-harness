// SPDX-License-Identifier: Apache-2.0
import { Code, TraceId, type Event, type Id } from "@rovinos/schemas";
import type { EventStore, IdempotencyKeyHash } from "./types.js";
import { InvalidEventError } from "./errors.js";
import {
  claimMemoryIdempotencyKey,
  deleteMemoryIdempotencyKeyClaims,
  releaseMemoryIdempotencyKey,
  takeoverMemoryIdempotencyKey,
  type MemoryIdempotencyClaim,
} from "./idempotency.js";

interface ApprovalNotification {
  readonly runId: Id;
  readonly claimedAt: number;
  readonly sentAt?: number;
}

/** In-memory outbox, claim, and trace indexes shared by the reference store. */
export class MemoryStoreAuxiliary {
  private readonly traceRuns = new Map<TraceId, Map<Id, number>>();
  private readonly outboxEvents: { readonly globalSeq: number; readonly event: Event }[] = [];
  private readonly sinkCursors = new Map<string, number>();
  private readonly approvalNotifications = new Map<Id, ApprovalNotification>();
  private readonly confirmationStates = new Map<string, number>();
  private readonly idempotencyKeys = new Map<string, MemoryIdempotencyClaim>();
  private nextGlobalSeq = 0;

  recordTraceRuns(runId: Id, events: readonly Event[]): void {
    for (const event of events) {
      let runs = this.traceRuns.get(event.traceId);
      if (runs === undefined) {
        runs = new Map<Id, number>();
        this.traceRuns.set(event.traceId, runs);
      }
      if (!runs.has(runId)) {
        runs.set(runId, this.nextGlobalSeq);
      }
      this.outboxEvents.push({ globalSeq: this.nextGlobalSeq + 1, event: structuredClone(event) });
      this.nextGlobalSeq += 1;
    }
  }

  deleteRun(runId: Id): void {
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
  }

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

  fetchOutbox(sinkId: string, limit: number): Promise<{ events: Event[]; cursor: number }> {
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

  ackOutbox(sinkId: string, cursor: number): Promise<void> {
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

  claimIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id, createdAt: number): Promise<Id> {
    return claimMemoryIdempotencyKey(this.idempotencyKeys, keyHash, runId, createdAt);
  }

  takeoverIdempotencyKey(
    keyHash: IdempotencyKeyHash,
    options: Parameters<EventStore["takeoverIdempotencyKey"]>[1],
    runs: ReadonlyMap<Id, readonly Event[]>,
  ): Promise<boolean> {
    return Promise.resolve().then(() =>
      takeoverMemoryIdempotencyKey(this.idempotencyKeys, runs, keyHash, options),
    );
  }

  releaseIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id): Promise<void> {
    return releaseMemoryIdempotencyKey(this.idempotencyKeys, keyHash, runId);
  }
}
