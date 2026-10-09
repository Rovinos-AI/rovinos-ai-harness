// SPDX-License-Identifier: Apache-2.0
import { type Event, type NewEvent } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { SeqConflictError } from "./errors.js";
import type { EventStore } from "./types.js";
import { createEventBuilders, type EventStoreTestBuilders } from "./testing.js";

/** Factory for a fresh store and its resource cleanup. */
export type EventStoreFactory = () => Promise<{
  store: EventStore;
  cleanup: () => Promise<void>;
}>;

/** Capabilities that control which optional conformance cases are registered. */
export interface EventStoreConformanceCaps {
  /** Whether the factory can reopen the same persistent store after cleanup. */
  supportsFileReopen: boolean;
}

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const result: Event[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
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

function registerAppendOrdering(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("appends and reads events in assigned sequence order", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const events = [
        builders.runCreated(runId),
        builders.modelRequest(runId),
        builders.modelRequest(runId),
      ];

      await expect(store.append(runId, events, 0)).resolves.toEqual({ nextSeq: 3 });
      const readEvents = await collect(store.read(runId));
      expect(readEvents.map(({ seq }) => seq)).toEqual([0, 1, 2]);
      expect(await store.head(runId)).toBe(3);
    });
  });
}

function registerRangeReads(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("reads inclusive sequence ranges", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      await store.append(
        runId,
        [
          builders.runCreated(runId),
          builders.modelRequest(runId),
          builders.modelRequest(runId),
          builders.modelRequest(runId),
        ],
        0,
      );

      expect(
        (await collect(store.read(runId, { fromSeq: 1, toSeq: 2 }))).map(({ seq }) => seq),
      ).toEqual([1, 2]);
    });
  });
}

function registerUnknownHead(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("returns a head of zero for an unknown run", async () => {
    await withStore(factory, async (store) => {
      expect(await store.head(builders.nextRunId())).toBe(0);
    });
  });
}

function registerStaleConflict(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("rejects stale expectedSeq without adding rows", () =>
    assertStaleConflictConformance(factory, builders));
}

/** Runs the shared stale-sequence assertion used by the conformance suite. */
export async function assertStaleConflictConformance(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): Promise<void> {
  await withStore(factory, async (store) => {
    const runId = builders.nextRunId();
    await store.append(runId, [builders.runCreated(runId)], 0);

    await expect(store.append(runId, [builders.modelRequest(runId)], 0)).rejects.toBeInstanceOf(
      SeqConflictError,
    );
    expect(await store.head(runId)).toBe(1);
    expect(await collect(store.read(runId))).toHaveLength(1);
  });
}

function registerAheadConflict(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("rejects expectedSeq ahead of the current head without adding rows", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      await store.append(runId, [builders.runCreated(runId)], 0);

      await expect(store.append(runId, [builders.modelRequest(runId)], 2)).rejects.toBeInstanceOf(
        SeqConflictError,
      );
      expect(await store.head(runId)).toBe(1);
      expect(await collect(store.read(runId))).toHaveLength(1);
    });
  });
}

function registerEmptyAppend(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("rejects an empty append", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      await expect(store.append(runId, [], 0)).rejects.toMatchObject({ code: "event_invalid" });
      expect(await store.head(runId)).toBe(0);
    });
  });
}

function registerMixedRunBatch(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("rejects a mixed-run batch without adding rows", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const otherRunId = builders.nextRunId();
      await expect(
        store.append(runId, [builders.runCreated(runId), builders.modelRequest(otherRunId)], 0),
      ).rejects.toMatchObject({ code: "event_invalid" });
      expect(await store.head(runId)).toBe(0);
      expect(await store.head(otherRunId)).toBe(0);
    });
  });
}

function registerInvalidEventAtomicity(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("rejects an invalid event atomically", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const invalidEvent: NewEvent = { ...builders.runCreated(runId), configHash: "invalid" };

      await expect(
        store.append(runId, [builders.runCreated(runId), invalidEvent], 0),
      ).rejects.toMatchObject({ code: "event_invalid" });
      expect(await store.head(runId)).toBe(0);
      expect(await collect(store.read(runId))).toEqual([]);
    });
  });
}

function registerRoundTrip(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("round-trips content, metadata, and optional fields", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const events = [
        builders.runCreated(runId, builders.nextRunId()),
        builders.modelRequest(runId, "synthetic round-trip content", {
          role: "user",
          schemaHash: "d".repeat(64),
        }),
      ];
      await store.append(runId, events, 0);

      expect(await collect(store.read(runId))).toEqual(
        events.map((event, seq) => ({ ...event, seq })),
      );
    });
  });
}

function registerLargeContent(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("round-trips large content", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const content = "x".repeat(
        1024 * 1024 - JSON.stringify({ messages: [{ content: "" }] }).length,
      );
      const events = [builders.runCreated(runId), builders.modelRequest(runId, content)];
      await store.append(runId, events, 0);

      expect(await collect(store.read(runId))).toEqual(
        events.map((event, seq) => ({ ...event, seq })),
      );
    });
  });
}

function registerRunListing(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("filters runs by status and paginates", async () => {
    await withStore(factory, async (store) => {
      const olderRunId = builders.nextRunId();
      const completedRunId = builders.nextRunId();
      const newestRunId = builders.nextRunId();
      await store.append(olderRunId, [builders.runCreated(olderRunId)], 0);
      await store.append(
        completedRunId,
        [
          builders.runCreated(completedRunId),
          builders.runStatusChanged(completedRunId, "pending", "completed"),
        ],
        0,
      );
      await store.append(newestRunId, [builders.runCreated(newestRunId)], 0);

      const firstPage = await store.listRuns({ limit: 1 });
      expect(firstPage.runs.map(({ runId }) => runId)).toEqual([newestRunId]);
      expect(firstPage.nextCursor).toBeDefined();
      const cursor = firstPage.nextCursor;
      if (cursor === undefined) {
        return;
      }
      const secondPage = await store.listRuns({ limit: 1, cursor });
      expect(secondPage.runs.map(({ runId }) => runId)).toEqual([completedRunId]);
      const completedRuns = await store.listRuns({ status: "completed", limit: 10 });
      expect(completedRuns.runs.map(({ runId }) => runId)).toEqual([completedRunId]);
      expect(completedRuns.nextCursor).toBeUndefined();
    });
  });
}

function registerStatusSummary(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("updates the run summary after run_status_changed", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      await store.append(
        runId,
        [
          builders.runCreated(runId),
          builders.runStatusChanged(runId, "pending", "running"),
          builders.runStatusChanged(runId, "running", "completed"),
        ],
        0,
      );

      await expect(store.listRuns({ status: "completed", limit: 1 })).resolves.toMatchObject({
        runs: [{ runId, status: "completed", lastSeq: 2 }],
      });
    });
  });
}

function registerLazyRead(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("reads the first 10 of 5,000 events quickly", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const events = [
        builders.runCreated(runId),
        ...Array.from({ length: 4_999 }, () => builders.modelRequest(runId)),
      ];
      await store.append(runId, events, 0);

      const iterator = store.read(runId)[Symbol.asyncIterator]();
      const startedAt = performance.now();
      for (let seq = 0; seq < 10; seq += 1) {
        const result = await iterator.next();
        expect(result.done).toBe(false);
        if (result.done === false) {
          expect(result.value.seq).toBe(seq);
        }
      }
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    });
  });
}

function registerFileReopen(factory: EventStoreFactory, builders: EventStoreTestBuilders): void {
  it("preserves data after closing and reopening the store", async () => {
    const first = await factory();
    const runId = builders.nextRunId();
    const event = builders.runCreated(runId);
    try {
      await first.store.append(runId, [event], 0);
    } finally {
      await first.cleanup();
    }

    await withStore(factory, async (store) => {
      expect(await collect(store.read(runId))).toEqual([{ ...event, seq: 0 }]);
    });
  });
}

/** Registers the shared behavioral tests required of every EventStore adapter. */
export function runEventStoreConformance(
  name: string,
  factory: EventStoreFactory,
  caps: EventStoreConformanceCaps,
): void {
  const builders = createEventBuilders();
  describe(`${name} EventStore conformance`, () => {
    registerAppendOrdering(factory, builders);
    registerRangeReads(factory, builders);
    registerUnknownHead(factory, builders);
    registerStaleConflict(factory, builders);
    registerAheadConflict(factory, builders);
    registerEmptyAppend(factory, builders);
    registerMixedRunBatch(factory, builders);
    registerInvalidEventAtomicity(factory, builders);
    registerRoundTrip(factory, builders);
    registerLargeContent(factory, builders);
    registerRunListing(factory, builders);
    registerStatusSummary(factory, builders);
    registerLazyRead(factory, builders);
    if (caps.supportsFileReopen) {
      registerFileReopen(factory, builders);
    }
  });
}
