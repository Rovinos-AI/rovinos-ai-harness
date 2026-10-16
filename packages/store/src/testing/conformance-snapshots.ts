// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import type { Id } from "@harness/schemas";
import { SeqConflictError } from "../errors.js";
import type { EventStore } from "../types.js";
import type { EventStoreFactory } from "./conformance.js";
import type { EventStoreTestBuilders } from "./testing.js";

async function withStore<T>(factory: EventStoreFactory, test: (store: EventStore) => Promise<T>) {
  const { store, cleanup } = await factory();
  try {
    return await test(store);
  } finally {
    await cleanup();
  }
}

function registerSnapshotRoundTrip(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("round-trips snapshot metadata and codec-backed content", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const snapshotId = builders.nextRunId();
      const snapshot = builders.snapshot(runId, snapshotId, 1);

      await expect(
        store.appendWithSnapshot(
          runId,
          [builders.runCreated(runId), builders.checkpointWritten(runId, snapshotId, 1)],
          0,
          snapshot,
        ),
      ).resolves.toEqual({ nextSeq: 2 });
      await expect(store.latestSnapshot(runId)).resolves.toEqual(snapshot);
    });
  });
}

function registerLatestSnapshot(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("selects the latest snapshot by atSeq, not creation time", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const firstId = builders.nextRunId();
      const secondId = builders.nextRunId();
      const first = { ...builders.snapshot(runId, firstId, 1), createdAt: 20 };
      const second = { ...builders.snapshot(runId, secondId, 2), createdAt: 10 };

      await store.appendWithSnapshot(
        runId,
        [builders.runCreated(runId), builders.checkpointWritten(runId, firstId, 1)],
        0,
        first,
      );
      await store.appendWithSnapshot(
        runId,
        [builders.checkpointWritten(runId, secondId, 2)],
        2,
        second,
      );

      await expect(store.latestSnapshot(runId)).resolves.toEqual(second);
      await expect(store.latestSnapshot(builders.nextRunId())).resolves.toBeUndefined();
    });
  });
}

function registerSnapshotConflict(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("leaves no snapshot or events when expectedSeq conflicts", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const snapshotId = builders.nextRunId();
      await store.append(runId, [builders.runCreated(runId)], 0);
      const snapshot = builders.snapshot(runId, snapshotId, 0);

      await expect(
        store.appendWithSnapshot(
          runId,
          [builders.checkpointWritten(runId, snapshotId, 0)],
          0,
          snapshot,
        ),
      ).rejects.toBeInstanceOf(SeqConflictError);
      await expect(store.latestSnapshot(runId)).resolves.toBeUndefined();
      await expect(store.head(runId)).resolves.toBe(1);
    });
  });
}

function registerSnapshotMismatch(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("rejects checkpoint and snapshot mismatches without writing events", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const snapshotId = builders.nextRunId();
      const otherId = builders.nextRunId();
      const snapshot = builders.snapshot(runId, snapshotId, 1);

      await expect(
        store.appendWithSnapshot(
          runId,
          [builders.runCreated(runId), builders.checkpointWritten(runId, otherId, snapshot.atSeq)],
          0,
          snapshot,
        ),
      ).rejects.toMatchObject({ code: "event_invalid" });
      await expect(
        store.appendWithSnapshot(
          runId,
          [builders.runCreated(runId), builders.checkpointWritten(runId, snapshotId, 2)],
          0,
          snapshot,
        ),
      ).rejects.toMatchObject({ code: "event_invalid" });
      await expect(
        store.appendWithSnapshot(
          runId,
          [
            builders.runCreated(runId),
            builders.checkpointWritten(runId, snapshotId, 1),
            builders.checkpointWritten(runId, otherId, 1),
          ],
          0,
          snapshot,
        ),
      ).rejects.toMatchObject({ code: "event_invalid" });
      await expect(store.latestSnapshot(runId)).resolves.toBeUndefined();
      await expect(store.head(runId)).resolves.toBe(0);
    });
  });

  it("rejects a snapshot beyond its checkpoint sequence without writing events", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const snapshotId = builders.nextRunId();
      const snapshot = builders.snapshot(runId, snapshotId, 2);

      await expect(
        store.appendWithSnapshot(
          runId,
          [builders.runCreated(runId), builders.checkpointWritten(runId, snapshotId, 2)],
          0,
          snapshot,
        ),
      ).rejects.toMatchObject({
        code: "event_invalid",
        paths: [["atSeq"]],
      });
      await expect(store.latestSnapshot(runId)).resolves.toBeUndefined();
      await expect(store.head(runId)).resolves.toBe(0);
    });
  });
}

async function appendSnapshots(
  store: EventStore,
  runId: Id,
  snapshotIds: readonly Id[],
  builders: EventStoreTestBuilders,
): Promise<void> {
  for (const [index, snapshotId] of snapshotIds.entries()) {
    const atSeq = index + 1;
    const events =
      index === 0
        ? [builders.runCreated(runId), builders.checkpointWritten(runId, snapshotId, atSeq)]
        : [builders.checkpointWritten(runId, snapshotId, atSeq)];
    await store.appendWithSnapshot(
      runId,
      events,
      index === 0 ? 0 : index + 1,
      builders.snapshot(runId, snapshotId, atSeq),
    );
  }
}

interface SnapshotPruningFixture {
  store: EventStore;
  runId: Id;
  snapshotIds: readonly Id[];
  expectedSeq: number;
  builders: EventStoreTestBuilders;
}

async function assertRetainedSnapshotsCannotBeReused(
  fixture: SnapshotPruningFixture,
): Promise<void> {
  const { store, runId, snapshotIds, expectedSeq, builders } = fixture;
  for (const retainedId of snapshotIds.slice(1)) {
    const retainedSnapshot = builders.snapshot(runId, retainedId, expectedSeq);
    await expect(
      store.appendWithSnapshot(
        runId,
        [builders.checkpointWritten(runId, retainedId, expectedSeq)],
        expectedSeq,
        retainedSnapshot,
      ),
    ).rejects.toMatchObject({
      code: "event_invalid",
      paths: [["snapshotId"]],
    });
    await expect(store.head(runId)).resolves.toBe(expectedSeq);
  }
}

async function assertPrunedSnapshotCanBeReused(
  fixture: Omit<SnapshotPruningFixture, "snapshotIds"> & { snapshotId: Id },
): Promise<void> {
  const { store, runId, snapshotId, expectedSeq, builders } = fixture;
  await expect(
    store.appendWithSnapshot(
      runId,
      [builders.checkpointWritten(runId, snapshotId, expectedSeq)],
      expectedSeq,
      builders.snapshot(runId, snapshotId, expectedSeq),
    ),
  ).resolves.toEqual({ nextSeq: expectedSeq + 1 });
}

function registerSnapshotPruning(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("prunes snapshots to exactly the configured default of five", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const snapshotIds = Array.from({ length: 6 }, () => builders.nextRunId());
      const firstId = snapshotIds[0];
      if (firstId === undefined) {
        throw new Error("Expected a snapshot identifier");
      }

      await appendSnapshots(store, runId, snapshotIds, builders);
      await expect(store.head(runId)).resolves.toBe(7);
      const latestSnapshots = await store.retainedSnapshots(runId, 2);
      expect(latestSnapshots.map(({ snapshotId, atSeq }) => ({ snapshotId, atSeq }))).toEqual(
        snapshotIds
          .slice(-2)
          .reverse()
          .map((snapshotId, index) => ({ snapshotId, atSeq: 6 - index })),
      );
      await expect(store.retainedSnapshots(runId, 20)).resolves.toHaveLength(5);
      await expect(store.retainedSnapshots(runId, 0)).rejects.toThrow(
        "Snapshot limit must be a positive integer",
      );
      const expectedSeq = await store.head(runId);
      const fixture = { store, runId, snapshotIds, expectedSeq, builders };
      await assertRetainedSnapshotsCannotBeReused(fixture);
      await assertPrunedSnapshotCanBeReused({ ...fixture, snapshotId: firstId });
    });
  });
}

/** Register the snapshot behavior shared by all EventStore adapters. */
export function registerSnapshotConformance(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  registerSnapshotRoundTrip(factory, builders);
  registerLatestSnapshot(factory, builders);
  registerSnapshotConflict(factory, builders);
  registerSnapshotMismatch(factory, builders);
  registerSnapshotPruning(factory, builders);
}

/** Register snapshot persistence across a durable store reopen. */
export function registerSnapshotReopenConformance(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("preserves snapshots after closing and reopening the store", async () => {
    const first = await factory();
    const runId = builders.nextRunId();
    const snapshotId = builders.nextRunId();
    const snapshot = builders.snapshot(runId, snapshotId, 1);
    try {
      await first.store.appendWithSnapshot(
        runId,
        [builders.runCreated(runId), builders.checkpointWritten(runId, snapshotId, 1)],
        0,
        snapshot,
      );
    } finally {
      await first.cleanup();
    }

    await withStore(factory, async (store) => {
      await expect(store.latestSnapshot(runId)).resolves.toEqual(snapshot);
    });
  });
}
