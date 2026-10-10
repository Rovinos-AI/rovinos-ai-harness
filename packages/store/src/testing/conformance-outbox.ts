// SPDX-License-Identifier: Apache-2.0
import { Code, type Id } from "@harness/schemas";
import { expect, it } from "vitest";
import type { EventStore } from "../types.js";
import type { EventStoreFactory } from "./conformance.js";
import type { EventStoreTestBuilders } from "./testing.js";

let outboxSinkId = 0;

function nextOutboxSinkId(): Code {
  outboxSinkId += 1;
  return Code.parse(`conformance.sink.${outboxSinkId.toString()}`);
}

async function withStore<T>(
  factory: EventStoreFactory,
  run: (store: EventStore) => Promise<T>,
): Promise<T> {
  const { store, cleanup } = await factory();
  try {
    return await run(store);
  } finally {
    await cleanup();
  }
}

async function advanceOutboxToEnd(store: EventStore): Promise<number> {
  const sinkId = nextOutboxSinkId();
  let batch = await store.fetchOutbox(sinkId, 5_000);
  while (batch.events.length !== 0) {
    await store.ackOutbox(sinkId, batch.cursor);
    batch = await store.fetchOutbox(sinkId, 5_000);
  }
  return batch.cursor;
}

function registerOutbox(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("rejects invalid sink ids, limits, and cursors", async () => {
    await withStore(factory, async (store) => {
      await expect(store.fetchOutbox("invalid sink", 1)).rejects.toMatchObject({
        code: "event_invalid",
      });
      await expect(store.fetchOutbox("sink.valid", 0)).rejects.toMatchObject({
        code: "event_invalid",
      });
      await expect(store.ackOutbox("sink.valid", -1)).rejects.toMatchObject({
        code: "event_invalid",
      });
      await expect(store.ackOutbox("invalid sink", 0)).rejects.toMatchObject({
        code: "event_invalid",
      });
    });
  });

  it("delivers at least once, acknowledges monotonically, and isolates sink cursors", async () => {
    await withStore(factory, async (store) => {
      const baseline = await advanceOutboxToEnd(store);
      const firstRunId = builders.nextRunId();
      const secondRunId = builders.nextRunId();
      await store.append(firstRunId, [builders.runCreated(firstRunId)], 0);
      await store.append(secondRunId, [builders.runCreated(secondRunId)], 0);
      await store.append(firstRunId, [builders.modelRequest(firstRunId)], 1);

      const firstSink = nextOutboxSinkId();
      const secondSink = nextOutboxSinkId();
      await store.ackOutbox(firstSink, baseline);
      await store.ackOutbox(secondSink, baseline);

      const firstBatch = await store.fetchOutbox(firstSink, 2);
      expect(firstBatch.events.map(({ runId, seq }) => [runId, seq])).toEqual([
        [firstRunId, 0],
        [secondRunId, 0],
      ]);
      expect(firstBatch.cursor).toBeGreaterThan(baseline);
      await expect(store.fetchOutbox(firstSink, 2)).resolves.toEqual(firstBatch);

      await store.ackOutbox(firstSink, firstBatch.cursor);
      await store.ackOutbox(firstSink, baseline);
      const remainingFirst = await store.fetchOutbox(firstSink, 2);
      expect(remainingFirst.events.map(({ runId, seq }) => [runId, seq])).toEqual([
        [firstRunId, 1],
      ]);
      await store.ackOutbox(firstSink, remainingFirst.cursor);
      await expect(store.fetchOutbox(firstSink, 2)).resolves.toEqual({
        events: [],
        cursor: remainingFirst.cursor,
      });

      const independentSecond = await store.fetchOutbox(secondSink, 10);
      expect(independentSecond.events.map(({ runId, seq }) => [runId, seq])).toEqual([
        [firstRunId, 0],
        [secondRunId, 0],
        [firstRunId, 1],
      ]);
      await store.ackOutbox(secondSink, independentSecond.cursor);
      await expect(store.fetchOutbox(secondSink, 10)).resolves.toMatchObject({
        events: [],
        cursor: independentSecond.cursor,
      });
    });
  });
}

function registerOutboxFileReopen(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("resumes a persisted outbox cursor after reopening the store", async () => {
    const first = await factory();
    const baseline = await advanceOutboxToEnd(first.store);
    const runId: Id = builders.nextRunId();
    const secondRunId = builders.nextRunId();
    const sinkId = nextOutboxSinkId();
    await first.store.append(runId, [builders.runCreated(runId)], 0);
    await first.store.append(secondRunId, [builders.runCreated(secondRunId)], 0);
    await first.store.append(runId, [builders.modelRequest(runId)], 1);
    await first.store.append(secondRunId, [builders.modelRequest(secondRunId)], 1);
    await first.store.ackOutbox(sinkId, baseline);
    const firstBatch = await first.store.fetchOutbox(sinkId, 2);
    expect(firstBatch.events.map(({ runId: eventRunId, seq }) => [eventRunId, seq])).toEqual([
      [runId, 0],
      [secondRunId, 0],
    ]);
    await first.store.ackOutbox(sinkId, firstBatch.cursor);
    await first.cleanup();

    await withStore(factory, async (store) => {
      const resumed = await store.fetchOutbox(sinkId, 2);
      expect(resumed.events.map(({ runId: eventRunId, seq }) => [eventRunId, seq])).toEqual([
        [runId, 1],
        [secondRunId, 1],
      ]);
      await store.ackOutbox(sinkId, resumed.cursor);
      await expect(store.fetchOutbox(sinkId, 2)).resolves.toEqual({
        events: [],
        cursor: resumed.cursor,
      });
    });
  });
}

/** Register shared outbox semantics tests for an EventStore adapter. */
export function registerOutboxConformance(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
  supportsFileReopen: boolean,
): void {
  registerOutbox(factory, builders);
  if (supportsFileReopen) {
    registerOutboxFileReopen(factory, builders);
  }
}
