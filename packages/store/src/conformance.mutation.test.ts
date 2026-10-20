// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { InMemoryEventStore, SeqConflictError } from "./index.js";
import type { EventStore } from "./types.js";
import { assertStaleConflictConformance, type EventStoreFactory } from "./testing/conformance.js";
import { createEventBuilders } from "./testing/testing.js";

function brokenFactory(): EventStoreFactory {
  return () => {
    const reference = new InMemoryEventStore();
    const store: EventStore = {
      async append(runId, events, expectedSeq, leaseOwner) {
        try {
          return await reference.append(runId, events, expectedSeq, leaseOwner);
        } catch (error) {
          if (error instanceof SeqConflictError) {
            return { nextSeq: expectedSeq + events.length };
          }
          throw error;
        }
      },
      appendWithSnapshot: (runId, events, expectedSeq, snapshot, leaseOwner) =>
        reference.appendWithSnapshot(runId, events, expectedSeq, snapshot, leaseOwner),
      appendWithUsage: (...args) => reference.appendWithUsage(...args),
      readUsageLedger: (...args) => reference.readUsageLedger(...args),
      claimRunExecution: (...args) => reference.claimRunExecution(...args),
      renewRunExecution: (...args) => reference.renewRunExecution(...args),
      releaseRunExecution: (...args) => reference.releaseRunExecution(...args),
      latestSnapshot: (runId) => reference.latestSnapshot(runId),
      retainedSnapshots: (runId, limit) => reference.retainedSnapshots(runId, limit),
      read: (runId, range) => reference.read(runId, range),
      watch: (runId, options) => reference.watch(runId, options),
      watchRuns: (options) => reference.watchRuns(options),
      head: (runId) => reference.head(runId),
      deleteRun: (runId) => reference.deleteRun(runId),
      consumeConfirmationState: (stateId, expiresAt, now) =>
        reference.consumeConfirmationState(stateId, expiresAt, now),
      claimIdempotencyKey: (keyHash, runId, createdAt) =>
        reference.claimIdempotencyKey(keyHash, runId, createdAt),
      takeoverIdempotencyKey: (...args) => reference.takeoverIdempotencyKey(...args),
      releaseIdempotencyKey: (keyHash, runId) => reference.releaseIdempotencyKey(keyHash, runId),
      listRuns: (options) => reference.listRuns(options),
      findRunsByTrace: (traceId) => reference.findRunsByTrace(traceId),
      fetchOutbox: (sinkId, limit) => reference.fetchOutbox(sinkId, limit),
      ackOutbox: (sinkId, cursor) => reference.ackOutbox(sinkId, cursor),
      claimApprovalNotification: (approvalId, runId, claimedAt, leaseMs) =>
        reference.claimApprovalNotification(approvalId, runId, claimedAt, leaseMs),
      markApprovalNotificationSent: (approvalId, runId, claimedAt, sentAt) =>
        reference.markApprovalNotificationSent(approvalId, runId, claimedAt, sentAt),
      releaseApprovalNotification: (approvalId, runId, claimedAt) =>
        reference.releaseApprovalNotification(approvalId, runId, claimedAt),
      close: () => reference.close(),
    };
    return Promise.resolve({ store, cleanup: () => reference.close() });
  };
}

describe("EventStore conformance mutation check", () => {
  it("detects a store that swallows sequence conflicts", async () => {
    await expect(
      assertStaleConflictConformance(brokenFactory(), createEventBuilders()),
    ).rejects.toThrow();
  });
});
