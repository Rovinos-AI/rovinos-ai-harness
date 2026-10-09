// SPDX-License-Identifier: Apache-2.0
import { Id, SequentialIdGenerator } from "@harness/schemas";
import { InMemoryEventStore, type EventStore } from "@harness/store";
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
  for await (const _event of store.read(runId)) {
    count += 1;
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
      if (mode === "before_commit") {
        expect(saved).toBeUndefined();
      } else {
        expect(saved).toMatchObject({ atSeq: 1 });
      }
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
