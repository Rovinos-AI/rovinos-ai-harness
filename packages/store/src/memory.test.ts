// SPDX-License-Identifier: Apache-2.0
import { Id, type Event, type NewEvent, type RunStatus } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import type { HarnessError } from "./index.js";
import {
  InvalidEventError,
  InMemoryEventStore,
  SeqConflictError,
  StoreUnavailableError,
} from "./index.js";

const runId = Id.parse("00000000000000000000000001");
const otherRunId = Id.parse("00000000000000000000000002");
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);

function runCreated(id: typeof runId, ts: number, configHash = "a".repeat(64)): NewEvent {
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
    messages: [{ content: "synthetic" }],
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
    if (
      !Array.isArray(messages) ||
      typeof messages[0] !== "object" ||
      messages[0] === null ||
      Array.isArray(messages[0])
    ) {
      throw new Error("Expected a nested message object");
    }
    messages[0].content = "changed";

    const secondRead = await collect(store.read(runId));
    const secondRequest = secondRead[1];
    if (secondRequest?.type !== "model_request" || !Array.isArray(secondRequest.messages)) {
      throw new Error("Expected a stored model request");
    }
    const secondMessage = secondRequest.messages[0];
    if (
      typeof secondMessage !== "object" ||
      secondMessage === null ||
      Array.isArray(secondMessage)
    ) {
      throw new Error("Expected a stored message object");
    }
    expect(secondMessage.content).toBe("synthetic");
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
    await expect(store.listRuns({ limit: 1, cursor: "unknown" })).resolves.toMatchObject({
      runs: [expect.objectContaining({ status: "pending", createdAt: 20, lastSeq: 0, lastTs: 20 })],
    });
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("omits runs without a run_created event from summaries", async () => {
    const store = new InMemoryEventStore();
    await store.append(otherRunId, [runStatusChanged(otherRunId, 10, "pending", "running")], 0);

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
