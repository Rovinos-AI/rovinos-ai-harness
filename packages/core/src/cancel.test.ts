// SPDX-License-Identifier: Apache-2.0
import { context, trace } from "@opentelemetry/api";
import { FakeClock, Id, SequentialIdGenerator, Sha256Hex, type Event } from "@harness/schemas";
import { InMemoryEventStore, type EventStore } from "@harness/store";
import { createTestContextManager, createTestTracerProvider } from "@harness/telemetry/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cancelRun } from "./cancel.js";
import { RunRecorder, type EventPartial } from "./recorder.js";
import { foldRunState } from "./run-state.js";
import { RUN_SPAN } from "./spans.js";

const runId = Id.parse("00000000000000000000000000");
const segmentId = Id.parse("11111111111111111111111111");
const tracerProvider = createTestTracerProvider();

beforeAll(() => {
  context.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(tracerProvider);
});

afterAll(() => {
  context.disable();
  trace.disable();
});

async function seedRun(
  store: EventStore,
  status: "pending" | "running" | "suspended" | "completed",
): Promise<void> {
  const events: EventPartial[] = [
    {
      type: "run_created",
      v: 1,
      configHash: Sha256Hex.parse("a".repeat(64)),
      policyVersion: "test",
    },
  ];
  if (status !== "pending") {
    events.push({
      type: "run_status_changed",
      v: 1,
      from: "pending",
      to: "running",
      reason: "start",
    });
  }
  if (status === "suspended") {
    events.push({
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "suspended",
      reason: "shutdown",
    });
  }
  if (status === "completed") {
    events.push({
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "completed",
      reason: "final_answer",
    });
  }
  const recorder = new RunRecorder(store, runId, segmentId, 0, new FakeClock(100));
  await recorder.withStepSpan(RUN_SPAN, {}, () =>
    recorder.recordBatch(events).then((recorded) => {
      const last = recorded.at(-1);
      if (last === undefined) {
        throw new Error("Expected seeded run events.");
      }
      return last;
    }),
  );
}

async function readEvents(store: EventStore): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

function competingEvent(seq: number): {
  readonly type: "model_request";
  readonly v: 1;
  readonly requestId: ReturnType<typeof Id.parse>;
  readonly provider: "test";
  readonly model: "test";
  readonly messages: [];
  readonly runId: ReturnType<typeof Id.parse>;
  readonly ts: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly segmentId: ReturnType<typeof Id.parse>;
} {
  return {
    type: "model_request",
    v: 1,
    requestId: Id.parse(String(seq).padStart(26, "0")),
    provider: "test",
    model: "test",
    messages: [],
    runId,
    ts: 101 + seq,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId,
  };
}

describe("cancelRun", () => {
  it.each(["pending", "running", "suspended"] as const)(
    "cancels a %s run with one durable terminal status event",
    async (status) => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(200);
      await seedRun(store, status);

      await expect(cancelRun(store, runId, clock, new SequentialIdGenerator())).resolves.toBe(
        "cancelled",
      );

      const events = await readEvents(store);
      const statusEvents = events.filter(
        (event) => event.type === "run_status_changed" && event.to === "cancelled",
      );
      expect(statusEvents).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: "run_status_changed",
        from: status,
        to: "cancelled",
        reason: "cancel_requested",
      });
      expect(foldRunState(events).status).toBe("cancelled");
    },
  );

  it("returns already_terminal without appending to a completed run", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "completed");
    const head = await store.head(runId);

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).resolves.toBe("already_terminal");

    expect(await store.head(runId)).toBe(head);
  });

  it("re-reads and retries when a live worker wins an append race", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "running");
    const append = store.append.bind(store);
    let raced = false;
    vi.spyOn(store, "append").mockImplementation(async (id, events, expectedSeq) => {
      if (!raced && events.some((event) => event.type === "run_status_changed")) {
        raced = true;
        await append(id, [competingEvent(expectedSeq)], expectedSeq);
      }
      return append(id, events, expectedSeq);
    });

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).resolves.toBe("cancelled");

    const events = await readEvents(store);
    expect(events.map((event) => event.type)).toContain("model_request");
    expect(
      events.filter((event) => event.type === "run_status_changed" && event.to === "cancelled"),
    ).toHaveLength(1);
  });

  it("stops after three consecutive append conflicts", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "running");
    const append = store.append.bind(store);
    let conflicts = 0;
    vi.spyOn(store, "append").mockImplementation(async (id, events, expectedSeq) => {
      if (events.some((event) => event.type === "run_status_changed") && conflicts < 3) {
        conflicts += 1;
        await append(id, [competingEvent(expectedSeq)], expectedSeq);
      }
      return append(id, events, expectedSeq);
    });

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).rejects.toMatchObject({ code: "cancel_conflict" });
    expect(conflicts).toBe(3);
    expect(
      (await readEvents(store)).some(
        (event) => event.type === "run_status_changed" && event.to === "cancelled",
      ),
    ).toBe(false);
  });
});
