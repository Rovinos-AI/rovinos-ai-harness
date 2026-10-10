// SPDX-License-Identifier: Apache-2.0
import type { Event } from "./events.js";

const id = "00000000000000000000000000";
const sha256 = "a".repeat(64);
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const traceparent = `00-${traceId}-${spanId}-01`;
const envelope = { runId: id, seq: 0, ts: 1, v: 1, traceId, spanId, segmentId: id };

/** Synthetic valid examples used by event schema and classification tests. */
export const eventSamples = [
  { ...envelope, type: "run_created", configHash: sha256, policyVersion: "policy.v1" },
  { ...envelope, type: "run_status_changed", from: "pending", to: "running", reason: "started" },
  {
    ...envelope,
    type: "model_request",
    requestId: id,
    provider: "test",
    model: "test",
    messages: [],
  },
  {
    ...envelope,
    type: "model_response",
    requestId: id,
    provider: "test",
    model: "test",
    inputTokens: 1,
    outputTokens: 2,
    costMicros: 3,
    finishReason: "stop",
    latencyMs: 3,
    schemaValid: true,
    repairAttempts: 0,
    content: {},
    providerBlobs: [],
    toolCalls: [{ callId: id, toolId: "test.tool", args: { value: "synthetic" } }],
  },
  {
    ...envelope,
    type: "tool_intent",
    callId: id,
    toolId: "test.tool",
    idempotent: false,
    policyDecision: "allow",
    argsHash: sha256,
    args: {},
  },
  {
    ...envelope,
    type: "tool_result",
    callId: id,
    toolId: "test.tool",
    outcome: "ok",
    latencyMs: 1,
    result: null,
  },
  { ...envelope, type: "approval_requested", approvalId: id, callId: id, payload: {} },
  { ...envelope, type: "approval_resolved", approvalId: id, decision: "approve", waitMs: 1 },
  {
    ...envelope,
    type: "checkpoint_written",
    checkpointId: id,
    atSeq: 1,
    traceparent,
  },
  {
    ...envelope,
    type: "context_compacted",
    fromSeq: 0,
    toSeq: 1,
    strategy: "summary",
    strategyVersion: "v1",
    summary: "compacted",
  },
  {
    ...envelope,
    type: "pii_action",
    boundary: "model_input",
    action: "tokenized",
    entities: [{ type: "email", count: 1 }],
  },
  { ...envelope, type: "budget_exceeded", budget: "steps", limit: 1, observed: 2 },
  { ...envelope, type: "subagent_spawned", childRunId: id, role: "researcher" },
  { ...envelope, type: "subagent_completed", childRunId: id, outcome: "completed" },
] satisfies Event[];
