// SPDX-License-Identifier: Apache-2.0
import { Code, Id, SequentialIdGenerator } from "@rovinos/schemas";
import { InMemoryEventStore, type EventStore } from "@rovinos/store";
import { describe, expect, it, vi } from "vitest";
import { CrashingEventStore, SimulatedCrash } from "./crash-store.js";

const runId = Id.parse("00000000000000000000000001");
const configHash = "a".repeat(64);

function startEvent() {
  return {
    runId,
    ts: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: "00000000000000000000000002",
    type: "run_created" as const,
    v: 1,
    configHash,
    policyVersion: "test",
  };
}

function statusEvent() {
  return {
    runId,
    ts: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: "00000000000000000000000002",
    type: "run_status_changed" as const,
    v: 1,
    from: "pending" as const,
    to: "running" as const,
    reason: "start",
  };
}

function checkpointAppend() {
  const ids = new SequentialIdGenerator();
  const checkpointId = Id.parse(ids.next());
  return {
    event: {
      runId,
      ts: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: "00000000000000000000000002",
      type: "checkpoint_written" as const,
      v: 1,
      checkpointId,
      atSeq: 1,
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    },
    snapshot: {
      snapshotId: checkpointId,
      runId,
      v: 1,
      atSeq: 1,
      createdAt: 1,
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      context: null,
      plan: null,
    },
  };
}

async function events(store: EventStore): Promise<number> {
  let count = 0;
  for await (const event of store.read(runId)) {
    if (event.seq >= 0) {
      count += 1;
    }
  }
  return count;
}

describe("CrashingEventStore", () => {
  it.each(["before_commit", "after_commit"] as const)(
    "injects an %s crash for append",
    async (mode) => {
      const inner = new InMemoryEventStore();
      const store = new CrashingEventStore(inner, { crashAt: 1, mode });

      await expect(store.append(runId, [startEvent()], 0)).rejects.toBeInstanceOf(SimulatedCrash);
      expect(store.appendCalls).toBe(1);
      await expect(store.head(runId)).resolves.toBe(mode === "before_commit" ? 0 : 1);
      await expect(events(store)).resolves.toBe(mode === "before_commit" ? 0 : 1);
      await inner.close();
    },
  );

  it.each(["before_commit", "after_commit"] as const)(
    "injects an %s crash for appendWithSnapshot",
    async (mode) => {
      const inner = new InMemoryEventStore();
      await inner.append(runId, [startEvent()], 0);
      const store = new CrashingEventStore(inner, { crashAt: 1, mode });
      const { event, snapshot } = checkpointAppend();

      await expect(store.appendWithSnapshot(runId, [event], 1, snapshot)).rejects.toBeInstanceOf(
        SimulatedCrash,
      );
      const saved = await store.latestSnapshot(runId);
      expect(saved?.atSeq).toBe(mode === "before_commit" ? undefined : 1);
      expect(store.appendCalls).toBe(1);
      await inner.close();
    },
  );

  it("crashes only once and delegates later appends and store operations", async () => {
    const inner = new InMemoryEventStore();
    const store = new CrashingEventStore(inner, { crashAt: 1, mode: "after_commit" });

    await expect(store.append(runId, [startEvent()], 0)).rejects.toBeInstanceOf(SimulatedCrash);
    await expect(store.append(runId, [statusEvent()], 1)).resolves.toEqual({ nextSeq: 2 });
    await expect(store.listRuns({ limit: 1 })).resolves.toMatchObject({ runs: [{ runId }] });
    await expect(store.findRunsByTrace("a".repeat(32))).resolves.toEqual([runId]);
    expect(store.appendCalls).toBe(2);
    await store.close();
  });

  it("keeps failing appends after a persistent crash", async () => {
    const inner = new InMemoryEventStore();
    const store = new CrashingEventStore(inner, {
      crashAt: 1,
      mode: "before_commit",
      persistentCrash: true,
    });

    await expect(store.append(runId, [startEvent()], 0)).rejects.toBeInstanceOf(SimulatedCrash);
    await expect(store.append(runId, [startEvent()], 0)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(store.appendCalls).toBe(2);
    await inner.close();
  });

  it("does not commit append calls after a persistent after-commit crash", async () => {
    const inner = new InMemoryEventStore();
    const store = new CrashingEventStore(inner, {
      crashAt: 1,
      mode: "after_commit",
      persistentCrash: true,
    });

    await expect(store.append(runId, [startEvent()], 0)).rejects.toBeInstanceOf(SimulatedCrash);
    await expect(store.append(runId, [statusEvent()], 1)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(store.appendCalls).toBe(2);
    await expect(store.head(runId)).resolves.toBe(1);
    await inner.close();
  });

  it("does not commit appendWithSnapshot calls after a persistent after-commit crash", async () => {
    const inner = new InMemoryEventStore();
    const store = new CrashingEventStore(inner, {
      crashAt: 1,
      mode: "after_commit",
      persistentCrash: true,
    });
    const { event, snapshot } = checkpointAppend();

    await expect(store.append(runId, [startEvent()], 0)).rejects.toBeInstanceOf(SimulatedCrash);
    await expect(store.appendWithSnapshot(runId, [event], 1, snapshot)).rejects.toBeInstanceOf(
      SimulatedCrash,
    );
    expect(store.appendCalls).toBe(2);
    await expect(store.head(runId)).resolves.toBe(1);
    await expect(store.latestSnapshot(runId)).resolves.toBeUndefined();
    await inner.close();
  });

  it("delegates approval notification lease operations", async () => {
    const inner = new InMemoryEventStore();
    const store = new CrashingEventStore(inner, { crashAt: 1, mode: "before_commit" });
    const approvalId = Id.parse("00000000000000000000000003");

    await expect(store.claimApprovalNotification(approvalId, runId, 100, 60)).resolves.toBe(true);
    await expect(store.markApprovalNotificationSent(approvalId, runId, 100, 101)).resolves.toBe(
      true,
    );
    await expect(store.claimApprovalNotification(approvalId, runId, 200, 60)).resolves.toBe(false);

    const retryApprovalId = Id.parse("00000000000000000000000004");
    await expect(store.claimApprovalNotification(retryApprovalId, runId, 100, 60)).resolves.toBe(
      true,
    );
    await store.releaseApprovalNotification(retryApprovalId, runId, 100);
    await expect(store.claimApprovalNotification(retryApprovalId, runId, 100, 60)).resolves.toBe(
      true,
    );
    await store.close();
  });

  it("delegates durable idempotency key claims and release", async () => {
    const inner = new InMemoryEventStore();
    const store = new CrashingEventStore(inner, { crashAt: 1, mode: "before_commit" });
    const keyHash = "d".repeat(64);

    await expect(store.claimIdempotencyKey(keyHash, runId, 100)).resolves.toBe(runId);
    await expect(store.releaseIdempotencyKey(keyHash, runId)).resolves.toBeUndefined();
    await store.close();
  });

  it("delegates execution leases, snapshots, watches, outbox, and deletion", async () => {
    const inner = new InMemoryEventStore();
    const store = new CrashingEventStore(inner, { crashAt: 100, mode: "before_commit" });
    const owner = Id.parse("00000000000000000000000005");
    const replacement = Id.parse("00000000000000000000000006");
    const leaseRunId = Id.parse("00000000000000000000000007");
    const keyHash = "e".repeat(64);

    await store.append(runId, [startEvent()], 0);
    await expect(store.claimRunExecution(runId, owner, 10, 100)).resolves.toBe(true);
    await expect(store.renewRunExecution(runId, owner, 20, 100)).resolves.toBe(true);
    await store.releaseRunExecution(runId, owner);
    await expect(store.claimRunExecution(runId, replacement, 30, 100)).resolves.toBe(true);
    const { event, snapshot } = checkpointAppend();
    await expect(store.appendWithSnapshot(runId, [event], 1, snapshot)).resolves.toEqual({
      nextSeq: 2,
    });
    await expect(store.latestSnapshot(runId)).resolves.toMatchObject({ atSeq: 1 });
    await expect(store.retainedSnapshots(runId, 1)).resolves.toHaveLength(1);

    const eventController = new AbortController();
    const eventIterator = store
      .watch(runId, {
        fromSeq: 0,
        signal: eventController.signal,
      })
      [Symbol.asyncIterator]();
    await expect(eventIterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "run_created" },
    });
    eventController.abort();
    await eventIterator.return?.();

    const summaryController = new AbortController();
    const summaryIterator = store
      .watchRuns({ signal: summaryController.signal })
      [Symbol.asyncIterator]();
    await expect(summaryIterator.next()).resolves.toMatchObject({
      done: false,
      value: { runId, status: "pending" },
    });
    summaryController.abort();
    await summaryIterator.return?.();

    const sinkId = Code.parse("test.sink");
    const batch = await store.fetchOutbox(sinkId, 10);
    expect(batch.events).toHaveLength(2);
    await store.ackOutbox(sinkId, batch.cursor);
    await expect(store.fetchOutbox(sinkId, 10)).resolves.toMatchObject({
      events: [],
      cursor: batch.cursor,
    });
    await expect(store.consumeConfirmationState("synthetic-state", 100, 10)).resolves.toBe(true);
    await expect(store.consumeConfirmationState("synthetic-state", 100, 10)).resolves.toBe(false);
    await expect(store.claimIdempotencyKey(keyHash, leaseRunId, 10)).resolves.toBe(leaseRunId);
    await expect(
      store.takeoverIdempotencyKey(keyHash, {
        expectedRunId: leaseRunId,
        runId: replacement,
        createdAt: 20,
        staleBefore: 10,
      }),
    ).resolves.toBe(true);
    await store.releaseIdempotencyKey(keyHash, replacement);

    await store.append(
      runId,
      [
        {
          ...statusEvent(),
          from: "pending",
          to: "completed",
        },
      ],
      2,
    );
    await expect(store.deleteRun(runId)).resolves.toBe(3);
    await store.close();
  });

  it("rejects invalid crash points", () => {
    expect(
      () => new CrashingEventStore(new InMemoryEventStore(), { crashAt: 0, mode: "before_commit" }),
    ).toThrow(RangeError);
    expect(
      () =>
        new CrashingEventStore(new InMemoryEventStore(), {
          crashAt: Number.NaN,
          mode: "after_commit",
        }),
    ).toThrow(RangeError);
  });

  it("propagates delegated append failures", async () => {
    const inner = new InMemoryEventStore();
    const append = vi.spyOn(inner, "append").mockRejectedValue(new Error("store failed"));
    const store = new CrashingEventStore(inner, { crashAt: 2, mode: "after_commit" });

    await expect(store.append(runId, [startEvent()], 0)).rejects.toThrow("store failed");
    expect(append).toHaveBeenCalledOnce();
    await inner.close();
  });
});
