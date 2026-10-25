// SPDX-License-Identifier: Apache-2.0
import { Id, type Event, type HarnessError, type NewEvent, type RunStatus } from "@rovinos/schemas";
import { describe, expect, it, vi } from "vitest";
import { AesGcmContentCodec } from "./aes-gcm-codec.js";
import {
  InvalidEventError,
  InMemoryEventStore,
  SeqConflictError,
  StoreUnavailableError,
} from "./index.js";
import { runEventStoreConformance, type EventStoreFactory } from "./testing/index.js";

const runId = Id.parse("00000000000000000000000001");
const otherRunId = Id.parse("00000000000000000000000002");
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const memoryFactory: EventStoreFactory = () => {
  const store = new InMemoryEventStore();
  return Promise.resolve({ store, cleanup: () => store.close() });
};
const encryptedMemoryFactory: EventStoreFactory = () => {
  const store = new InMemoryEventStore(
    new AesGcmContentCodec({
      currentKeyId: () => "memory-conformance-key",
      getKey: () => Promise.resolve(new Uint8Array(32).fill(13)),
    }),
  );
  return Promise.resolve({ store, cleanup: () => store.close() });
};

function runCreated(
  id: typeof runId,
  ts: number,
  configHash = "a".repeat(64),
  continuationOf?: typeof runId,
): NewEvent {
  return {
    runId: id,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: id,
    type: "run_created",
    configHash,
    policyVersion: "policy.v1",
    ...(continuationOf === undefined ? {} : { continuationOf }),
    depth: 0,
  };
}

function modelRequest(id: typeof runId, ts: number): NewEvent {
  return {
    runId: id,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: id,
    type: "model_request",
    requestId: id,
    provider: "test",
    model: "test",
    messages: [{ role: "user", parts: [{ type: "text", text: "synthetic" }] }],
  };
}

function modelResponse(id: typeof runId, ts: number, costMicros: number): NewEvent {
  return {
    runId: id,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: id,
    type: "model_response",
    requestId: id,
    provider: "test",
    model: "test",
    inputTokens: 1,
    outputTokens: 1,
    costMicros,
    finishReason: "stop",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: "synthetic" }],
    providerBlobs: null,
  };
}

function runStatusChanged(id: typeof runId, ts: number, from: RunStatus, to: RunStatus): NewEvent {
  return {
    runId: id,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: id,
    type: "run_status_changed",
    from,
    to,
    reason: "test.transition",
  };
}

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe("InMemoryEventStore", () => {
  runEventStoreConformance("InMemoryEventStore", memoryFactory, { supportsFileReopen: false });
  runEventStoreConformance("InMemoryEventStore encrypted", encryptedMemoryFactory, {
    supportsFileReopen: false,
  });

  it("appends events and reads them in assigned sequence order", async () => {
    const store = new InMemoryEventStore();

    const append = store.append(runId, [runCreated(runId, 10), modelRequest(runId, 11)], 0);
    await expect(store.head(runId)).resolves.toBe(2);
    await expect(append).resolves.toEqual({
      nextSeq: 2,
    });

    const readEvents = store.read(runId);
    const events = await collect(readEvents);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.seq)).toEqual([0, 1]);
    expect(await collect(readEvents)).toEqual(events);
    await expect(store.head(runId)).resolves.toBe(2);
    await expect(store.head(otherRunId)).resolves.toBe(0);
  });

  it("commits model usage with its event and rolls both back on a sequence conflict", async () => {
    const store = new InMemoryEventStore();
    await store.append(runId, [runCreated(runId, 10)], 0);

    await store.appendWithUsage(runId, [modelResponse(runId, 11, 500)], 1, {
      usageUpdates: [
        { quotaId: "daily", period: "day", periodStart: 0, costMicros: 500, runsStarted: 0 },
      ],
    });
    await expect(store.readUsageLedger("daily", "day", [0])).resolves.toEqual([
      { quotaId: "daily", period: "day", periodStart: 0, costMicros: 500, runsStarted: 0 },
    ]);
    await expect(
      store.appendWithUsage(runId, [modelResponse(runId, 12, 200)], 1, {
        usageUpdates: [
          { quotaId: "daily", period: "day", periodStart: 0, costMicros: 200, runsStarted: 0 },
        ],
      }),
    ).rejects.toBeInstanceOf(SeqConflictError);

    await expect(store.head(runId)).resolves.toBe(2);
    await expect(store.readUsageLedger("daily", "day", [0])).resolves.toEqual([
      { quotaId: "daily", period: "day", periodStart: 0, costMicros: 500, runsStarted: 0 },
    ]);
    await store.close();
  });

  it("serializes concurrent hourly run-start increments against one quota limit", async () => {
    const store = new InMemoryEventStore();
    const runIds = Array.from({ length: 10 }, (_, index) =>
      Id.parse(String(index + 10).padStart(26, "0")),
    );
    const results = await Promise.allSettled(
      runIds.map((id, index) =>
        store.appendWithUsage(id, [runCreated(id, index + 1)], 0, {
          usageUpdates: [
            {
              quotaId: "hourly",
              period: "hour",
              periodStart: 3_600_000,
              costMicros: 0,
              runsStarted: 1,
              maxRunsStarted: 5,
            },
          ],
        }),
      ),
    );

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(5);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(5);
    await expect(store.readUsageLedger("hourly", "hour", [3_600_000])).resolves.toEqual([
      { quotaId: "hourly", period: "hour", periodStart: 3_600_000, costMicros: 0, runsStarted: 5 },
    ]);
    await store.close();
  });

  it("refreshes only the run that changes while watching many idle runs", async () => {
    const store = new InMemoryEventStore();
    const builders = Array.from({ length: 40 }, (_, index) =>
      Id.parse(String(index + 10).padStart(26, "0")),
    );
    for (const [index, id] of builders.entries()) {
      await store.append(id, [runCreated(id, index + 1)], 0);
    }
    const listRuns = vi.spyOn(store, "listRuns");
    const read = vi.spyOn(store, "read");
    const controller = new AbortController();
    const iterator = store.watchRuns({ signal: controller.signal })[Symbol.asyncIterator]();
    try {
      await Promise.all(builders.map(() => iterator.next()));
      const changedRunId = builders[20];
      if (changedRunId === undefined) {
        throw new Error("Expected a changed run id");
      }
      await store.append(
        changedRunId,
        [runStatusChanged(changedRunId, 100, "pending", "running")],
        1,
      );

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { runId: changedRunId, status: "running" },
      });
      expect(listRuns).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(changedRunId, { fromSeq: 1, toSeq: 1 });
    } finally {
      controller.abort();
      await iterator.return?.();
      await store.close();
    }
  });

  it("rejects stale sequence numbers without appending", async () => {
    const store = new InMemoryEventStore();
    await store.append(runId, [runCreated(runId, 10)], 0);

    await expect(store.append(runId, [modelRequest(runId, 11)], 0)).rejects.toBeInstanceOf(
      SeqConflictError,
    );
    await expect(store.head(runId)).resolves.toBe(1);
  });

  it("yields deep clones so mutations cannot change stored events", async () => {
    const store = new InMemoryEventStore();
    await store.append(runId, [runCreated(runId, 10), modelRequest(runId, 11)], 0);

    const firstRead = await collect(store.read(runId));
    const returnedRequest = firstRead[1];
    if (returnedRequest?.type !== "model_request") {
      throw new Error("Expected an event object");
    }
    const messages = returnedRequest.messages;
    const firstPart = messages[0]?.parts[0];
    if (firstPart?.type !== "text") {
      throw new Error("Expected a text part");
    }
    firstPart.text = "changed";

    const secondRead = await collect(store.read(runId));
    const secondRequest = secondRead[1];
    if (secondRequest?.type !== "model_request") {
      throw new Error("Expected a stored model request");
    }
    expect(secondRequest.messages[0]?.parts[0]).toEqual({ type: "text", text: "synthetic" });
  });

  it("rejects empty, cross-run, and invalid batches atomically", async () => {
    const store = new InMemoryEventStore();

    await expect(store.append(runId, [], 0)).rejects.toBeInstanceOf(InvalidEventError);
    await expect(store.append(runId, [runCreated(otherRunId, 10)], 0)).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    await expect(
      store.append(runId, [runCreated(runId, 10), runCreated(runId, 11, "invalid")], 0),
    ).rejects.toMatchObject({ paths: [["configHash"]] });
    await expect(store.head(runId)).resolves.toBe(0);
  });

  it("supports inclusive read ranges and run listing with status and cursors", async () => {
    const store = new InMemoryEventStore();
    const anotherId = Id.parse("00000000000000000000000003");
    await store.append(runId, [runCreated(runId, 10), modelRequest(runId, 11)], 0);
    await store.append(
      runId,
      [
        runStatusChanged(runId, 12, "pending", "running"),
        runStatusChanged(runId, 13, "running", "completed"),
      ],
      2,
    );
    await store.append(anotherId, [runCreated(anotherId, 20)], 0);

    expect(await collect(store.read(runId, { fromSeq: 1, toSeq: 1 }))).toHaveLength(1);
    expect(await collect(store.read(otherRunId))).toEqual([]);
    const firstPage = await store.listRuns({ limit: 1 });
    expect(firstPage.runs).toHaveLength(1);
    expect(firstPage.runs[0]?.runId).toBe(anotherId);
    expect(firstPage.nextCursor).toBe(anotherId);
    const cursor = firstPage.nextCursor;
    if (cursor === undefined) {
      throw new Error("Expected a next-page cursor");
    }
    const secondPage = await store.listRuns({ limit: 1, cursor });
    expect(secondPage.runs[0]).toMatchObject({
      runId,
      status: "completed",
      lastSeq: 3,
      lastTs: 13,
    });

    await expect(store.listRuns({ status: "running", limit: 2 })).resolves.toEqual({ runs: [] });
    await expect(store.listRuns({ status: "completed", limit: 2 })).resolves.toMatchObject({
      runs: [expect.objectContaining({ runId, status: "completed" })],
    });
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("filters run listings to direct continuations without mixing branches", async () => {
    const store = new InMemoryEventStore();
    const firstBranch = Id.parse("00000000000000000000000003");
    const secondBranch = Id.parse("00000000000000000000000004");
    await store.append(runId, [runCreated(runId, 10)], 0);
    await store.append(firstBranch, [runCreated(firstBranch, 20, "a".repeat(64), runId)], 0);
    await store.append(secondBranch, [runCreated(secondBranch, 30, "a".repeat(64), runId)], 0);

    await expect(store.listRuns({ continuationOf: runId, limit: 10 })).resolves.toMatchObject({
      runs: [{ runId: secondBranch }, { runId: firstBranch }],
    });
  });

  it("rejects unknown run-list cursors", async () => {
    const store = new InMemoryEventStore();
    await store.append(runId, [runCreated(runId, 10)], 0);

    await expect(store.listRuns({ limit: 1, cursor: "stale-cursor" })).rejects.toMatchObject({
      paths: [["cursor"]],
      message: "Event input is invalid",
    });
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid run-list limit %s", async (limit) => {
    const store = new InMemoryEventStore();

    await expect(store.listRuns({ limit })).rejects.toMatchObject({
      paths: [["limit"]],
      message: "Event input is invalid",
    });
  });

  it("rejects a run that does not start with run_created", async () => {
    const store = new InMemoryEventStore();
    await expect(
      store.append(otherRunId, [runStatusChanged(otherRunId, 10, "pending", "running")], 0),
    ).rejects.toMatchObject({
      paths: [[0, "type"]],
    });

    await expect(store.head(otherRunId)).resolves.toBe(0);
    await expect(store.listRuns({ limit: 10 })).resolves.toEqual({ runs: [] });
  });
});

describe("store errors", () => {
  it("exposes stable codes without exposing schema values", () => {
    const errors: HarnessError[] = [
      new SeqConflictError(2, 1),
      new StoreUnavailableError(),
      new InvalidEventError([["payload", 0]]),
    ];

    expect(errors.map((error) => error.code)).toEqual([
      "seq_conflict",
      "store_unavailable",
      "event_invalid",
    ]);
    expect(errors[2]).toMatchObject({ paths: [["payload", 0]] });
    expect(errors[2]?.message).toBe("Event input is invalid");
  });
});
