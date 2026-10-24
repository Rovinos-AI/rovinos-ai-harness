// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import type { EventStore } from "../types.js";
import type { EventStoreFactory } from "./conformance.js";
import type { EventStoreTestBuilders } from "./testing.js";

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

/** Assert that writes committed while subscriptions start are caught up from storage. */
export async function assertWatchSubscriptionConformance(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): Promise<void> {
  await withStore(factory, async (store) => {
    const runId = builders.nextRunId();
    const controller = new AbortController();
    const events = store
      .watch(runId, { fromSeq: 0, signal: controller.signal })
      [Symbol.asyncIterator]();
    const runs = store
      .watchRuns({ statuses: ["completed"], signal: controller.signal })
      [Symbol.asyncIterator]();
    try {
      const firstEvent = events.next();
      const firstRun = runs.next();
      await store.append(
        runId,
        [builders.runCreated(runId), builders.runStatusChanged(runId, "pending", "completed")],
        0,
      );
      await expect(firstEvent).resolves.toMatchObject({
        done: false,
        value: { runId, seq: 0, type: "run_created" },
      });
      await expect(events.next()).resolves.toMatchObject({
        done: false,
        value: { runId, seq: 1, to: "completed" },
      });
      await expect(events.next()).resolves.toMatchObject({ done: true });
      let nextRun = await firstRun;
      while (nextRun.done === false && nextRun.value.runId !== runId) {
        nextRun = await runs.next();
      }
      expect(nextRun).toMatchObject({
        done: false,
        value: { runId, status: "completed", lastSeq: 1 },
      });
    } finally {
      controller.abort();
      await events.return?.();
      await runs.return?.();
    }
  });
}

function registerCatchupAndTerminal(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("catches up, follows appended events in order, and ends after a terminal event", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      await store.append(runId, [builders.runCreated(runId), builders.modelRequest(runId)], 0);
      const controller = new AbortController();
      const iterator = store
        .watch(runId, {
          fromSeq: 1,
          signal: controller.signal,
          maxBuffered: 1,
        })
        [Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { seq: 1 },
      });
      const liveEvent = iterator.next();
      await store.append(
        runId,
        [builders.modelRequest(runId), builders.runStatusChanged(runId, "pending", "completed")],
        2,
      );
      await expect(liveEvent).resolves.toMatchObject({ done: false, value: { seq: 2 } });
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { seq: 3, type: "run_status_changed", to: "completed" },
      });
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
    });
  });
}

function registerAbort(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("ends a waiting subscription when its signal aborts", async () => {
    await withStore(factory, async (store) => {
      const controller = new AbortController();
      const iterator = store
        .watch(builders.nextRunId(), { fromSeq: 0, signal: controller.signal })
        [Symbol.asyncIterator]();
      const waiting = iterator.next();
      controller.abort();
      await expect(waiting).resolves.toMatchObject({ done: true });
    });
  });
}

function registerInvalidOptions(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("rejects an invalid watch offset and buffer limit", async () => {
    await withStore(factory, async (store) => {
      const signal = new AbortController().signal;
      const invalidOffset = store.watch(builders.nextRunId(), { fromSeq: -1, signal });
      await expect(invalidOffset[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: "event_invalid",
      });
      const invalidBuffer = store.watch(builders.nextRunId(), {
        fromSeq: 0,
        signal,
        maxBuffered: 0,
      });
      await expect(invalidBuffer[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: "event_invalid",
      });
    });
  });
}

function registerSlowConsumer(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("re-reads stored rows instead of buffering when the consumer is slow", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      await store.append(runId, [builders.runCreated(runId)], 0);
      const controller = new AbortController();
      const iterator = store
        .watch(runId, {
          fromSeq: 0,
          signal: controller.signal,
          maxBuffered: 1,
        })
        [Symbol.asyncIterator]();
      const received: number[] = [];
      const first = await iterator.next();
      if (first.done !== false) {
        throw new Error("Expected the run-created event");
      }
      received.push(first.value.seq);

      await store.append(
        runId,
        [
          builders.modelRequest(runId),
          builders.modelRequest(runId),
          builders.runStatusChanged(runId, "pending", "completed"),
        ],
        1,
      );
      for (;;) {
        const next = await iterator.next();
        if (next.done !== false) {
          break;
        }
        received.push(next.value.seq);
      }
      expect(received).toEqual([0, 1, 2, 3]);
    });
  });
}

function registerRunStatusChanges(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("reports each matching status transition", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      await store.append(runId, [builders.runCreated(runId)], 0);
      const controller = new AbortController();
      const iterator = store
        .watchRuns({
          statuses: ["failed", "cancelled"],
          signal: controller.signal,
        })
        [Symbol.asyncIterator]();
      const firstTransition = iterator.next();
      await store.append(
        runId,
        [
          builders.runStatusChanged(runId, "pending", "running"),
          builders.runStatusChanged(runId, "running", "failed"),
          builders.runStatusChanged(runId, "failed", "cancelled"),
        ],
        1,
      );
      await expect(firstTransition).resolves.toMatchObject({
        done: false,
        value: { runId, status: "failed", lastSeq: 2 },
      });
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { runId, status: "cancelled", lastSeq: 3 },
      });
      controller.abort();
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
    });
  });
}

/** Registers shared live-subscription behavior for each EventStore adapter. */
export function registerWatchConformance(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("catches writes committed immediately after subscribing", async () => {
    await assertWatchSubscriptionConformance(factory, builders);
  });
  registerCatchupAndTerminal(factory, builders);
  registerAbort(factory, builders);
  registerInvalidOptions(factory, builders);
  registerSlowConsumer(factory, builders);
  registerRunStatusChanges(factory, builders);
}
