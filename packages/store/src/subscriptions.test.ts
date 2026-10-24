// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import { InMemoryEventStore } from "./memory.js";
import { ChangeEmitter, watchEvents, watchRunSummaries } from "./subscriptions.js";
import { createEventBuilders } from "./testing/testing.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

it("catches every matching transition committed before the listener is ready", async () => {
  const store = new InMemoryEventStore();
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  await store.append(runId, [builders.runCreated(runId)], 0);
  const baselineRead = deferred();
  const listenerReady = deferred();
  const listRuns = store.listRuns.bind(store);
  vi.spyOn(store, "listRuns").mockImplementation(async (options) => {
    const page = await listRuns(options);
    baselineRead.resolve();
    return page;
  });
  const emitter = new ChangeEmitter();
  const controller = new AbortController();
  const iterator = watchRunSummaries(
    store,
    { statuses: ["failed", "cancelled"], signal: controller.signal },
    async (id, signal) => {
      await listenerReady.promise;
      return emitter.subscribe(id, signal);
    },
  )[Symbol.asyncIterator]();
  try {
    const first = iterator.next();
    await baselineRead.promise;
    await store.append(
      runId,
      [
        builders.runStatusChanged(runId, "pending", "running"),
        builders.runStatusChanged(runId, "running", "failed"),
        builders.runStatusChanged(runId, "failed", "cancelled"),
      ],
      1,
    );
    listenerReady.resolve();
    await expect(first).resolves.toMatchObject({
      done: false,
      value: { runId, status: "failed", lastSeq: 2 },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { runId, status: "cancelled", lastSeq: 3 },
    });
    const waiting = iterator.next();
    controller.abort();
    await expect(waiting).resolves.toMatchObject({ done: true });
  } finally {
    controller.abort();
    listenerReady.resolve();
    await iterator.return?.();
    await store.close();
  }
});

it("reads watched events only after the listener is ready", async () => {
  const store = new InMemoryEventStore();
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const listenerReady = deferred();
  const head = vi.spyOn(store, "head");
  const emitter = new ChangeEmitter();
  const controller = new AbortController();
  const iterator = watchEvents(
    store,
    runId,
    { fromSeq: 0, signal: controller.signal },
    {
      async subscribe(id, signal) {
        await listenerReady.promise;
        return emitter.subscribe(id, signal);
      },
      isTerminal: () => Promise.resolve(false),
    },
  )[Symbol.asyncIterator]();
  try {
    const first = iterator.next();
    expect(head).not.toHaveBeenCalled();
    await store.append(runId, [builders.runCreated(runId)], 0);
    listenerReady.resolve();
    await expect(first).resolves.toMatchObject({
      done: false,
      value: { runId, seq: 0 },
    });
  } finally {
    controller.abort();
    listenerReady.resolve();
    await iterator.return?.();
    await store.close();
  }
});
