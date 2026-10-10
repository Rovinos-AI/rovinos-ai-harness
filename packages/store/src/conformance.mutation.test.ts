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
      async append(runId, events, expectedSeq) {
        try {
          return await reference.append(runId, events, expectedSeq);
        } catch (error) {
          if (error instanceof SeqConflictError) {
            return { nextSeq: expectedSeq + events.length };
          }
          throw error;
        }
      },
      appendWithSnapshot: (runId, events, expectedSeq, snapshot) =>
        reference.appendWithSnapshot(runId, events, expectedSeq, snapshot),
      latestSnapshot: (runId) => reference.latestSnapshot(runId),
      read: (runId, range) => reference.read(runId, range),
      head: (runId) => reference.head(runId),
      listRuns: (options) => reference.listRuns(options),
      findRunsByTrace: (traceId) => reference.findRunsByTrace(traceId),
      fetchOutbox: (sinkId, limit) => reference.fetchOutbox(sinkId, limit),
      ackOutbox: (sinkId, cursor) => reference.ackOutbox(sinkId, cursor),
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
