// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import type { Event, RunStatus } from "@harness/schemas";
import { CorruptLogError, foldRunState, RUN_TRIGGERS, transition, type RunState } from "./index.js";

const id = "00000000000000000000000000";
const hash = "a".repeat(64);
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const envelope = (seq: number, ts = seq + 1) => ({
  runId: id,
  seq,
  ts,
  v: 1,
  traceId,
  spanId,
  segmentId: id,
});

function runCreated(seq: number): Event {
  return { ...envelope(seq), type: "run_created", configHash: hash, policyVersion: "test.policy" };
}

function statusChanged(seq: number, from: RunStatus, to: RunStatus, reason: string): Event {
  return { ...envelope(seq), type: "run_status_changed", from, to, reason };
}

function toolIntent(seq: number, callId = id): Event {
  return {
    ...envelope(seq),
    type: "tool_intent",
    callId,
    toolId: "test.tool",
    idempotent: false,
    policyDecision: "allow",
    argsHash: hash,
    args: {},
  };
}

function toolResult(seq: number, callId = id): Event {
  return {
    ...envelope(seq),
    type: "tool_result",
    callId,
    toolId: "test.tool",
    outcome: "ok",
    latencyMs: 1,
    result: null,
  };
}

function approvalRequested(seq: number, approvalId = id): Event {
  return { ...envelope(seq), type: "approval_requested", approvalId, callId: id, payload: {} };
}

function approvalResolved(seq: number, approvalId = id): Event {
  return {
    ...envelope(seq),
    type: "approval_resolved",
    approvalId,
    decision: "approve",
    waitMs: 1,
  };
}

function modelResponse(seq: number): Event {
  return {
    ...envelope(seq),
    type: "model_response",
    requestId: id,
    provider: "test",
    model: "test",
    inputTokens: 3,
    outputTokens: 5,
    finishReason: "stop",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    content: {},
    providerBlobs: [],
  };
}

function checkpoint(seq: number): Event {
  return {
    ...envelope(seq),
    type: "checkpoint_written",
    checkpointId: id,
    atSeq: seq,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

function appendEvent(events: Event[], event: Event): void {
  events.push(event);
}

function seededRandom(seed: number): () => number {
  let value = seed;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

describe("foldRunState", () => {
  test("removes a pending tool intent when its result arrives", () => {
    const state = foldRunState([runCreated(0), toolIntent(1), toolResult(2)]);

    expect(state.pendingToolCalls.size).toBe(0);
    expect(state.nextSeq).toBe(3);
    expect(state.startedAt).toBe(1);
    expect(state.lastTs).toBe(3);
  });

  test("tracks approval lifecycle, model usage, checkpoint, and the current segment", () => {
    const state = foldRunState([
      runCreated(0),
      approvalRequested(1),
      modelResponse(2),
      checkpoint(3),
      approvalResolved(4),
    ]);

    expect(state.pendingApprovals.size).toBe(0);
    expect(state.steps).toBe(1);
    expect(state.usage).toEqual({ inputTokens: 3, outputTokens: 5, costMicros: 0 });
    expect(state.lastCheckpoint).toEqual({ checkpointId: id, atSeq: 3 });
    expect(state.segmentId).toBe(id);
    expect(state.lastTs).toBe(5);
  });

  test("rejects an illegal status sequence with corrupt_log", () => {
    expect(new CorruptLogError().code).toBe("corrupt_log");
    expect(() => foldRunState([statusChanged(0, "pending", "completed", "complete")])).toThrow(
      CorruptLogError,
    );
    expect(() => foldRunState([statusChanged(0, "running", "suspended", "shutdown")])).toThrow(
      CorruptLogError,
    );
  });

  test("folding the same events produces the same state without changing the log", () => {
    const events = [
      runCreated(0),
      statusChanged(1, "pending", "running", "start"),
      modelResponse(2),
      toolIntent(3),
      approvalRequested(4),
      checkpoint(5),
    ];
    const before = structuredClone(events);

    const first = foldRunState(events);
    const second = foldRunState(events);

    expect(first).toEqual(second);
    expect(events).toEqual(before);
  });

  test("generated legal event sequences always fold", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = seededRandom(seed);
      const events: Event[] = [runCreated(0)];
      let status: RunStatus = "pending";
      let seq = 1;

      for (let step = 0; step < 20; step += 1) {
        const allowed = RUN_TRIGGERS.filter((trigger) => transition(status, trigger).ok);
        if (allowed.length === 0) {
          break;
        }
        const trigger = allowed[Math.floor(random() * allowed.length)];
        if (trigger === undefined) {
          break;
        }
        const result = transition(status, trigger);
        if (!result.ok) {
          break;
        }
        appendEvent(events, statusChanged(seq, status, result.to, trigger));
        seq += 1;
        status = result.to;

        const extraEvent = Math.floor(random() * 5);
        switch (extraEvent) {
          case 0:
            appendEvent(events, toolIntent(seq));
            break;
          case 1:
            appendEvent(events, toolResult(seq));
            break;
          case 2:
            appendEvent(events, approvalRequested(seq));
            break;
          case 3:
            appendEvent(events, approvalResolved(seq));
            break;
          default:
            appendEvent(events, modelResponse(seq));
        }
        seq += 1;
      }

      const state: RunState = foldRunState(events);
      expect(state.nextSeq).toBe(seq);
    }
  });
});
