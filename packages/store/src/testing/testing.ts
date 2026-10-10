// SPDX-License-Identifier: Apache-2.0
import {
  FakeClock,
  Id,
  SequentialIdGenerator,
  type NewEvent,
  type RunStatus,
  type Snapshot,
} from "@harness/schemas";

/** Deterministic event builders used by EventStore tests. */
export interface EventStoreTestBuilders {
  nextRunId(): Id;
  runCreated(runId: Id, parentRunId?: Id): Extract<NewEvent, { type: "run_created" }>;
  modelRequest(
    runId: Id,
    content?: string,
    options?: { role?: string; schemaHash?: string },
  ): Extract<NewEvent, { type: "model_request" }>;
  runStatusChanged(
    runId: Id,
    from: RunStatus,
    to: RunStatus,
  ): Extract<NewEvent, { type: "run_status_changed" }>;
  checkpointWritten(
    runId: Id,
    checkpointId: Id,
    atSeq: number,
  ): Extract<NewEvent, { type: "checkpoint_written" }>;
  snapshot(runId: Id, snapshotId: Id, atSeq: number): Snapshot;
}

function checkpointWritten(
  nextTimestamp: () => number,
  runId: Id,
  checkpointId: Id,
  atSeq: number,
): Extract<NewEvent, { type: "checkpoint_written" }> {
  return {
    runId,
    ts: nextTimestamp(),
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: runId,
    type: "checkpoint_written",
    checkpointId,
    atSeq,
    traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  };
}

function createSnapshot(
  nextTimestamp: () => number,
  runId: Id,
  snapshotId: Id,
  atSeq: number,
): Snapshot {
  return {
    snapshotId,
    runId,
    atSeq,
    createdAt: nextTimestamp(),
    traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    context: { messages: ["synthetic context"] },
    plan: ["synthetic plan"],
  };
}

/** Creates deterministic event builders for EventStore tests. */
export function createEventBuilders(): EventStoreTestBuilders {
  const clock = new FakeClock(1);
  const ids = new SequentialIdGenerator();
  const nextId = () => Id.parse(ids.next());
  const nextTimestamp = () => {
    const timestamp = clock.now();
    clock.advance(1);
    return timestamp;
  };

  return {
    nextRunId: nextId,
    runCreated(runId, parentRunId) {
      return {
        runId,
        ts: nextTimestamp(),
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: runId,
        type: "run_created",
        configHash: "c".repeat(64),
        policyVersion: "policy.v1",
        ...(parentRunId === undefined ? {} : { parentRunId }),
      };
    },
    modelRequest(runId, content = "synthetic content", options = {}) {
      return {
        runId,
        ts: nextTimestamp(),
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: runId,
        type: "model_request",
        requestId: nextId(),
        provider: "test",
        model: "test",
        messages: [{ role: "user", parts: [{ type: "text", text: content }] }],
        ...(options.role === undefined ? {} : { role: options.role }),
        ...(options.schemaHash === undefined ? {} : { schemaHash: options.schemaHash }),
      };
    },
    runStatusChanged(runId, from, to) {
      return {
        runId,
        ts: nextTimestamp(),
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: runId,
        type: "run_status_changed",
        from,
        to,
        reason: "test.transition",
      };
    },
    checkpointWritten: (runId, checkpointId, atSeq) =>
      checkpointWritten(nextTimestamp, runId, checkpointId, atSeq),
    snapshot: (runId, snapshotId, atSeq) => createSnapshot(nextTimestamp, runId, snapshotId, atSeq),
  };
}
