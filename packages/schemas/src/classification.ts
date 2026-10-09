// SPDX-License-Identifier: Apache-2.0
import { EventSchema, type Event, type EventType, type PayloadKeys } from "./events.js";

/** Whether an event field is safe metadata or encrypted content. */
export type EventFieldClass = "meta" | "content";

/**
 * Classifies every payload key. New keys default to `content` unless explicitly proven metadata.
 */
export const EVENT_FIELD_CLASS = {
  run_created: { configHash: "meta", policyVersion: "meta", parentRunId: "meta" },
  run_status_changed: { from: "meta", to: "meta", reason: "meta" },
  model_request: {
    requestId: "meta",
    provider: "meta",
    model: "meta",
    role: "meta",
    schemaHash: "meta",
    messages: "content",
  },
  model_response: {
    requestId: "meta",
    provider: "meta",
    model: "meta",
    inputTokens: "meta",
    outputTokens: "meta",
    finishReason: "meta",
    latencyMs: "meta",
    schemaValid: "meta",
    repairAttempts: "meta",
    content: "content",
    providerBlobs: "content",
  },
  tool_intent: {
    callId: "meta",
    toolId: "meta",
    idempotent: "meta",
    policyDecision: "meta",
    argsHash: "meta",
    args: "content",
  },
  tool_result: {
    callId: "meta",
    toolId: "meta",
    outcome: "meta",
    errorCode: "meta",
    latencyMs: "meta",
    executedArgsHash: "meta",
    result: "content",
  },
  approval_requested: { approvalId: "meta", callId: "meta", expiresAt: "meta", payload: "content" },
  approval_resolved: {
    approvalId: "meta",
    decision: "meta",
    waitMs: "meta",
    edits: "content",
  },
  checkpoint_written: {
    checkpointId: "meta",
    atSeq: "meta",
    traceparent: "meta",
    workspaceRef: "meta",
  },
  context_compacted: {
    fromSeq: "meta",
    toSeq: "meta",
    strategy: "meta",
    strategyVersion: "meta",
    summary: "content",
  },
  pii_action: { boundary: "meta", action: "meta", entities: "meta" },
  budget_exceeded: { budget: "meta", limit: "meta", observed: "meta" },
  subagent_spawned: { childRunId: "meta", role: "meta", parentCallId: "meta" },
  subagent_completed: { childRunId: "meta", outcome: "meta" },
} satisfies { [T in EventType]: Record<PayloadKeys<T>, EventFieldClass> };

const envelopeKeys = new Set(["runId", "seq", "ts", "type", "v", "traceId", "spanId", "segmentId"]);

/**
 * Splits an event into its always-meta envelope and classified payloads.
 *
 * @param event - Validated event to split.
 * @returns The meta and content records, omitting absent optional fields.
 */
export function splitEvent(event: Event): {
  meta: Record<string, unknown>;
  content: Record<string, unknown>;
} {
  const meta: Record<string, unknown> = {};
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined) {
      continue;
    }
    if (
      envelopeKeys.has(key) ||
      Object.entries(EVENT_FIELD_CLASS[event.type]).find(([field]) => field === key)?.[1] === "meta"
    ) {
      meta[key] = value;
    } else {
      content[key] = value;
    }
  }
  return { meta, content };
}

/**
 * Reassembles and validates an event from its separately stored parts.
 *
 * @param meta - Event envelope and meta-classified payload.
 * @param content - Content-classified payload.
 * @returns The validated event.
 */
export function joinEvent(meta: Record<string, unknown>, content: Record<string, unknown>): Event {
  return EventSchema.parse({ ...content, ...meta });
}
