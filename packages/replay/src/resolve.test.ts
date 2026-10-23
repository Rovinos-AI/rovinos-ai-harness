// SPDX-License-Identifier: Apache-2.0
import { Readable } from "node:stream";
import { Event as EventSchema, Id, type Event, type Id as RunId } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import { describe, expect, it, vi } from "vitest";
import { ResolvedRunSchema, resolveRun } from "./index.js";

const traceId = "1234567890abcdef1234567890abcdef";
const spanId = "1234567890abcdef";
const runId = Id.parse("00000000000000000000000001");
const childRunId = Id.parse("00000000000000000000000002");

function createdEvent(id: RunId, parentRunId?: RunId): Event {
  return EventSchema.parse({
    runId: id,
    seq: 0,
    ts: 1,
    v: 1,
    traceId,
    spanId,
    segmentId: id,
    type: "run_created",
    configHash: "a".repeat(64),
    policyVersion: "test",
    ...(parentRunId === undefined ? {} : { parentRunId }),
    depth: parentRunId === undefined ? 0 : 1,
  });
}

function inputEvent(id: RunId, seq: number, input = "synthetic replay content"): Event {
  return EventSchema.parse({
    runId: id,
    seq,
    ts: seq + 1,
    v: 1,
    traceId,
    spanId,
    segmentId: id,
    type: "run_input",
    input,
    inputKind: "initial",
  });
}

function spawnEvent(parentRunId: RunId, referencedChildRunId: RunId, seq: number): Event {
  return EventSchema.parse({
    runId: parentRunId,
    seq,
    ts: seq + 1,
    v: 1,
    traceId,
    spanId,
    segmentId: parentRunId,
    type: "subagent_spawned",
    childRunId: referencedChildRunId,
    role: "worker",
  });
}

function createStore(
  logs: ReadonlyMap<RunId, readonly Event[]>,
  matches: readonly RunId[] = [],
): Pick<EventStore, "findRunsByTrace" | "read"> {
  return {
    findRunsByTrace: vi.fn(() => Promise.resolve([...matches])),
    read: (selectedRunId) => Readable.from(logs.get(selectedRunId) ?? []),
  };
}

describe("resolveRun", () => {
  it("resolves a run id and validates the complete log", async () => {
    const events = [createdEvent(runId), inputEvent(runId, 1)];
    const result = await resolveRun({
      store: createStore(new Map([[runId, events]])),
      runId,
    });

    expect(ResolvedRunSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({
      rootRunId: runId,
      runs: [{ runId, role: "root", events }],
    });
  });

  it("loads the referenced subagent tree when resolving a run id", async () => {
    const rootEvents = [createdEvent(runId), spawnEvent(runId, childRunId, 1)];
    const childEvents = [createdEvent(childRunId, runId)];
    const result = await resolveRun({
      store: createStore(
        new Map([
          [runId, rootEvents],
          [childRunId, childEvents],
        ]),
      ),
      runId,
    });

    expect(result).toEqual({
      rootRunId: runId,
      runs: [
        { runId, role: "root", events: rootEvents },
        { runId: childRunId, role: "subagent", parentRunId: runId, events: childEvents },
      ],
    });
  });

  it("loads nested subagents recursively", async () => {
    const grandchildRunId = Id.parse("00000000000000000000000003");
    const rootEvents = [createdEvent(runId), spawnEvent(runId, childRunId, 1)];
    const childEvents = [
      createdEvent(childRunId, runId),
      spawnEvent(childRunId, grandchildRunId, 1),
    ];
    const grandchildEvents = [createdEvent(grandchildRunId, childRunId)];
    const result = await resolveRun({
      store: createStore(
        new Map([
          [runId, rootEvents],
          [childRunId, childEvents],
          [grandchildRunId, grandchildEvents],
        ]),
      ),
      runId,
    });

    expect(
      result.runs.map(({ runId: id, role, parentRunId }) => ({ id, role, parentRunId })),
    ).toEqual([
      { id: runId, role: "root", parentRunId: undefined },
      { id: childRunId, role: "subagent", parentRunId: runId },
      { id: grandchildRunId, role: "subagent", parentRunId: childRunId },
    ]);
  });

  it.each([
    ["bare trace id", traceId],
    ["W3C traceparent", `00-${traceId}-${spanId}-01`],
  ])("resolves a trace supplied as %s", async (_description, value) => {
    const store = createStore(new Map([[runId, [createdEvent(runId)]]]), [runId]);

    await expect(resolveRun({ store, traceId: value })).resolves.toMatchObject({
      rootRunId: runId,
      runs: [{ runId, role: "root" }],
    });
    expect(store.findRunsByTrace).toHaveBeenCalledWith(traceId);
  });

  it("places the unique parent run before its subagent", async () => {
    const root = createdEvent(runId);
    const child = createdEvent(childRunId, runId);
    const store = createStore(
      new Map([
        [runId, [root]],
        [childRunId, [child]],
      ]),
      [childRunId, runId],
    );

    await expect(resolveRun({ store, traceId })).resolves.toEqual({
      rootRunId: runId,
      runs: [
        { runId, role: "root", events: [root] },
        { runId: childRunId, role: "subagent", parentRunId: runId, events: [child] },
      ],
    });
  });

  it("reports all ids when a trace has multiple possible roots", async () => {
    const otherRunId = Id.parse("00000000000000000000000003");
    const store = createStore(
      new Map([
        [runId, [createdEvent(runId)]],
        [otherRunId, [createdEvent(otherRunId)]],
      ]),
      [runId, otherRunId],
    );

    await expect(resolveRun({ store, traceId })).rejects.toMatchObject({
      code: "trace_ambiguous",
      runIds: [runId, otherRunId],
    });
  });

  it("reports all ids when a trace has no possible root", async () => {
    const store = createStore(
      new Map([
        [runId, [createdEvent(runId, childRunId)]],
        [childRunId, [createdEvent(childRunId, runId)]],
      ]),
      [runId, childRunId],
    );

    await expect(resolveRun({ store, traceId })).rejects.toMatchObject({
      code: "trace_ambiguous",
      runIds: [runId, childRunId],
    });
  });

  it("rejects a trace containing only a subagent", async () => {
    const store = createStore(new Map([[childRunId, [createdEvent(childRunId, runId)]]]), [
      childRunId,
    ]);

    await expect(resolveRun({ store, traceId })).rejects.toMatchObject({
      code: "trace_ambiguous",
      runIds: [childRunId],
    });
  });

  it("rejects a trace subagent whose parent is not among the matches", async () => {
    const otherRunId = Id.parse("00000000000000000000000003");
    const store = createStore(
      new Map([
        [runId, [createdEvent(runId)]],
        [childRunId, [createdEvent(childRunId, otherRunId)]],
      ]),
      [runId, childRunId],
    );

    await expect(resolveRun({ store, traceId })).rejects.toMatchObject({
      code: "trace_ambiguous",
      runIds: [runId, childRunId],
    });
  });

  it("throws run_not_found for unknown run and trace ids", async () => {
    const store = createStore(new Map());

    await expect(resolveRun({ store, runId })).rejects.toMatchObject({ code: "run_not_found" });
    await expect(resolveRun({ store, traceId })).rejects.toMatchObject({ code: "run_not_found" });
  });

  it.each([
    { description: "missing selector", selectors: {} },
    { description: "both selectors", selectors: { runId, traceId } },
    { description: "invalid run id", selectors: { runId: "not-a-run" } },
    { description: "invalid trace id", selectors: { traceId: "not-a-trace" } },
    { description: "zero trace id", selectors: { traceId: "0".repeat(32) } },
    {
      description: "invalid traceparent",
      selectors: { traceId: `00-${"0".repeat(32)}-${spanId}-01` },
    },
    {
      description: "zero span id in traceparent",
      selectors: { traceId: `00-${traceId}-${"0".repeat(16)}-01` },
    },
  ])("rejects $description", async ({ selectors }) => {
    await expect(resolveRun({ store: createStore(new Map()), ...selectors })).rejects.toMatchObject(
      { code: "replay_input_invalid" },
    );
  });

  it("rejects a log whose sequence is not contiguous from zero", async () => {
    const store = createStore(new Map([[runId, [createdEvent(runId), inputEvent(runId, 2)]]]));

    await expect(resolveRun({ store, runId })).rejects.toMatchObject({ code: "corrupt_log" });
  });

  it("rejects a log that does not start with run_created", async () => {
    const store = createStore(new Map([[runId, [inputEvent(runId, 0)]]]));

    await expect(resolveRun({ store, runId })).rejects.toMatchObject({ code: "corrupt_log" });
  });

  it("rejects events stored under a different run id", async () => {
    const store = createStore(new Map([[runId, [createdEvent(childRunId)]]]));

    await expect(resolveRun({ store, runId })).rejects.toMatchObject({ code: "corrupt_log" });
  });

  it("rejects more than one million events without buffering the excess", async () => {
    const store: Pick<EventStore, "findRunsByTrace" | "read"> = {
      findRunsByTrace: () => Promise.resolve([]),
      read: () =>
        Readable.from(
          (function* () {
            yield createdEvent(runId);
            const input = inputEvent(runId, 1);
            for (let seq = 1; seq <= 1_000_000; seq += 1) {
              yield { ...input, seq };
            }
          })(),
        ),
    };

    await expect(resolveRun({ store, runId })).rejects.toMatchObject({
      code: "replay_too_large",
    });
  });
});
