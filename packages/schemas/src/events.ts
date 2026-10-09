// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { JsonValue } from "./json.js";
import { Code, Id, Sha256Hex, SpanId, TraceId, Traceparent, WorkspaceRef } from "./primitives.js";

/** Supported run lifecycle states. */
export const RunStatus = z.enum([
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
]);

/** Inferred run lifecycle status. */
export type RunStatus = z.infer<typeof RunStatus>;

const eventEnvelopeShape = {
  runId: Id,
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  v: z.number().int().positive(),
  traceId: TraceId,
  spanId: SpanId,
  segmentId: Id,
};

/** Common event fields; the discriminant and payload are defined by each event type. */
export const EventEnvelopeSchema = z.object(eventEnvelopeShape).strict();

const runCreatedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run_created"),
    configHash: Sha256Hex,
    policyVersion: Code,
    parentRunId: Id.optional(),
  })
  .strict();

const runStatusChangedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run_status_changed"),
    from: RunStatus,
    to: RunStatus,
    reason: Code,
  })
  .strict();

const modelRequestEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("model_request"),
    requestId: Id,
    provider: Code,
    model: Code,
    role: Code.optional(),
    schemaHash: Sha256Hex.optional(),
    messages: JsonValue,
  })
  .strict();

const modelResponseEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("model_response"),
    requestId: Id,
    provider: Code,
    model: Code,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative().optional(),
    finishReason: Code,
    latencyMs: z.number().int().nonnegative(),
    schemaValid: z.boolean(),
    repairAttempts: z.number().int().nonnegative(),
    content: JsonValue,
    providerBlobs: JsonValue,
  })
  .strict();

const toolIntentEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("tool_intent"),
    callId: Id,
    toolId: Code,
    idempotent: z.boolean(),
    policyDecision: z.enum(["allow", "ask", "deny"]),
    argsHash: Sha256Hex,
    args: JsonValue,
  })
  .strict();

const toolResultEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("tool_result"),
    callId: Id,
    toolId: Code,
    outcome: z.enum(["ok", "error", "denied", "timeout"]),
    errorCode: Code.optional(),
    latencyMs: z.number().int().nonnegative(),
    executedArgsHash: Sha256Hex.optional(),
    result: JsonValue,
  })
  .strict();

const approvalRequestedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("approval_requested"),
    approvalId: Id,
    callId: Id,
    expiresAt: z.number().int().nonnegative().optional(),
    payload: JsonValue,
  })
  .strict();

const approvalResolvedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("approval_resolved"),
    approvalId: Id,
    decision: z.enum(["approve", "deny", "edit"]),
    waitMs: z.number().int().nonnegative(),
    edits: JsonValue.optional(),
  })
  .strict();

const checkpointWrittenEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("checkpoint_written"),
    checkpointId: Id,
    atSeq: z.number().int().nonnegative(),
    traceparent: Traceparent,
    workspaceRef: WorkspaceRef.optional(),
  })
  .strict();

const contextCompactedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("context_compacted"),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
    strategy: Code,
    strategyVersion: Code,
    summary: JsonValue,
  })
  .strict();

const piiActionEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("pii_action"),
    boundary: z.enum(["model_input", "tool_input", "tool_output", "storage", "ui"]),
    action: z.enum(["tokenized", "redacted", "blocked", "allowed"]),
    entities: z.array(z.object({ type: Code, count: z.number().int().nonnegative() }).strict()),
  })
  .strict();

const budgetExceededEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("budget_exceeded"),
    budget: z.enum(["steps", "cost", "wall_clock"]),
    limit: z.number(),
    observed: z.number(),
  })
  .strict();

const subagentSpawnedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("subagent_spawned"),
    childRunId: Id,
    role: Code,
    parentCallId: Id.optional(),
  })
  .strict();

const subagentCompletedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("subagent_completed"),
    childRunId: Id,
    outcome: z.enum(["completed", "failed", "cancelled"]),
  })
  .strict();

/** Strict discriminated union of the canonical event schemas. */
export const EventSchema = z.discriminatedUnion("type", [
  runCreatedEvent,
  runStatusChangedEvent,
  modelRequestEvent,
  modelResponseEvent,
  toolIntentEvent,
  toolResultEvent,
  approvalRequestedEvent,
  approvalResolvedEvent,
  checkpointWrittenEvent,
  contextCompactedEvent,
  piiActionEvent,
  budgetExceededEvent,
  subagentSpawnedEvent,
  subagentCompletedEvent,
]);

/** Runtime schema for canonical, strictly validated events. */
export const Event = EventSchema;

/** A validated event in the append-only run log. */
export type Event = z.infer<typeof Event>;

/** Discriminant values supported by {@link EventSchema}. */
export type EventType = Event["type"];

/** Event payload keys, excluding the common envelope and discriminant. */
export type PayloadKeys<T extends EventType> = Exclude<
  keyof Extract<Event, { type: T }>,
  keyof typeof eventEnvelopeShape | "type"
>;

/** Event input before the store assigns its sequence number. */
export type NewEvent = Event extends infer T ? (T extends Event ? Omit<T, "seq"> : never) : never;
