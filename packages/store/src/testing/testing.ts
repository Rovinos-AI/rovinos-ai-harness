// SPDX-License-Identifier: Apache-2.0
import {
  FakeClock,
  Id,
  SequentialIdGenerator,
  type NewEvent,
  type RunStatus,
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
        messages: [{ content }],
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
  };
}
