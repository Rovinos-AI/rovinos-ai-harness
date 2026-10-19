// SPDX-License-Identifier: Apache-2.0
import { Code, type Event, type Code as EventCode, type Pseudonym } from "@harness/schemas";
import { attr } from "./attr.js";
import { z } from "zod";

const commonFields = {
  runId: attr.id(),
  seq: attr.nonnegativeInt(),
  ts: attr.nonnegativeInt(),
  traceId: attr.traceId(),
  spanId: attr.spanId(),
  policyVersion: attr.code(),
};

const modelCall = z
  .object({
    ...commonFields,
    kind: attr.enum(["model_call"]),
    provider: attr.code(),
    model: attr.code(),
    inputTokens: attr.nonnegativeInt(),
    outputTokens: attr.nonnegativeInt(),
    latencyMs: attr.nonnegativeInt(),
    schemaValid: attr.bool(),
    repairAttempts: attr.nonnegativeInt(),
    finishReason: attr.code(),
  })
  .strict();

const toolCall = z
  .object({
    ...commonFields,
    kind: attr.enum(["tool_call"]),
    toolId: attr.code(),
    outcome: attr.enum(["ok", "error", "denied", "timeout"]),
    errorCode: attr.optional(attr.code()),
    latencyMs: attr.nonnegativeInt(),
  })
  .strict();

const policyDecision = z
  .object({
    ...commonFields,
    kind: attr.enum(["policy_decision"]),
    toolId: attr.code(),
    policyDecision: attr.enum(["allow", "ask", "deny"]),
    ruleId: attr.optional(attr.code()),
  })
  .strict();

const approvalWait = z
  .object({
    ...commonFields,
    kind: attr.enum(["approval_wait"]),
    decision: attr.enum(["approve", "deny", "edit"]),
    decidedBy: attr.enum(["human", "policy", "expiry"]),
    approverPseudonym: attr.optional(attr.pseudonym()),
    reason: attr.optional(attr.code()),
    waitMs: attr.nonnegativeInt(),
  })
  .strict();

const checkpoint = z
  .object({
    ...commonFields,
    kind: attr.enum(["checkpoint"]),
    atSeq: attr.nonnegativeInt(),
    hasWorkspaceRef: attr.bool(),
  })
  .strict();

const runStatus = z
  .object({
    ...commonFields,
    kind: attr.enum(["run_status"]),
    from: attr.enum(["pending", "running", "suspended", "completed", "failed", "cancelled"]),
    to: attr.enum(["pending", "running", "suspended", "completed", "failed", "cancelled"]),
    reason: attr.code(),
  })
  .strict();

const piiAction = z
  .object({
    ...commonFields,
    kind: attr.enum(["pii_action"]),
    boundary: attr.enum([
      "model_input",
      "tool_input",
      "tool_output",
      "storage",
      "ui",
      "telemetry_export",
    ]),
    action: attr.enum(["tokenized", "redacted", "blocked", "allowed", "detokenized"]),
    toolId: attr.optional(attr.code()),
    entities: z.array(z.object({ type: attr.code(), count: attr.nonnegativeInt() }).strict()),
  })
  .strict();

const budgetExceeded = z
  .object({
    ...commonFields,
    kind: attr.enum(["budget_exceeded"]),
    budget: attr.enum(["steps", "cost", "wall_clock"]),
    limit: attr.num(),
    observed: attr.num(),
  })
  .strict();

const subagentSpawned = z
  .object({
    ...commonFields,
    kind: attr.enum(["subagent_spawned"]),
    childRunId: attr.id(),
    role: attr.code(),
    parentCallId: attr.optional(attr.id()),
  })
  .strict();

const subagentCompleted = z
  .object({
    ...commonFields,
    kind: attr.enum(["subagent_completed"]),
    childRunId: attr.id(),
    outcome: attr.enum(["completed", "failed", "cancelled"]),
    inputTokens: attr.nonnegativeInt(),
    outputTokens: attr.nonnegativeInt(),
    costMicros: attr.optional(attr.nonnegativeInt()),
  })
  .strict();

const runCreated = z
  .object({
    ...commonFields,
    kind: attr.enum(["run_created"]),
    configHash: attr.hash(),
    requestedByPseudonym: attr.optional(attr.pseudonym()),
  })
  .strict();

/** Strict, branded schemas for every safe event kind. */
export const safeEventSchemas = [
  modelCall,
  toolCall,
  policyDecision,
  approvalWait,
  checkpoint,
  runStatus,
  piiAction,
  budgetExceeded,
  subagentSpawned,
  subagentCompleted,
  runCreated,
] as const;

/** Closed projection schema for metadata-only events exported to telemetry sinks. */
export const SafeEvent = z.discriminatedUnion("kind", safeEventSchemas).brand<"SafeEvent">();

/** Inferred safe event type. */
export type SafeEvent = z.infer<typeof SafeEvent>;

type SafeEventEnvelope = Pick<Event, "runId" | "seq" | "ts" | "traceId" | "spanId"> & {
  policyVersion: EventCode;
};

/** Identity pseudonyms explicitly supplied by an opt-in correlation exporter. */
export interface SafeEventPseudonyms {
  readonly requestedBy?: Pseudonym;
  readonly approverId?: Pseudonym;
}

type UnexportedEvent = Extract<
  Event,
  {
    type:
      | "run_input"
      | "model_request"
      | "tool_execution_started"
      | "approval_requested"
      | "context_compacted"
      | "app_content";
  }
>;

function createEnvelope(event: Event, policyVersion: EventCode): SafeEventEnvelope {
  return {
    runId: event.runId,
    seq: event.seq,
    ts: event.ts,
    traceId: event.traceId,
    spanId: event.spanId,
    policyVersion: Code.parse(policyVersion),
  };
}

function isUnexportedEvent(event: Event): event is UnexportedEvent {
  // run_input carries the user's goal (content); only its inputKind is meta, so it is not exported.
  return (
    event.type === "run_input" ||
    event.type === "model_request" ||
    event.type === "tool_execution_started" ||
    event.type === "approval_requested" ||
    event.type === "context_compacted" ||
    event.type === "app_content"
  );
}

function projectModelResponse(
  event: Extract<Event, { type: "model_response" }>,
  envelope: SafeEventEnvelope,
): SafeEvent {
  return SafeEvent.parse({
    ...envelope,
    kind: "model_call",
    provider: event.provider,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    latencyMs: event.latencyMs,
    schemaValid: event.schemaValid,
    repairAttempts: event.repairAttempts,
    finishReason: event.finishReason,
  });
}

function projectToolResult(
  event: Extract<Event, { type: "tool_result" }>,
  envelope: SafeEventEnvelope,
): SafeEvent {
  return SafeEvent.parse({
    ...envelope,
    kind: "tool_call",
    toolId: event.toolId,
    outcome: event.outcome,
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    latencyMs: event.latencyMs,
  });
}

function projectToolIntent(
  event: Extract<Event, { type: "tool_intent" }>,
  envelope: SafeEventEnvelope,
): SafeEvent {
  return SafeEvent.parse({
    ...envelope,
    kind: "policy_decision",
    toolId: event.toolId,
    policyDecision: event.policyDecision,
    ...(event.ruleId === undefined ? {} : { ruleId: event.ruleId }),
  });
}

function projectApprovalResolved(
  event: Extract<Event, { type: "approval_resolved" }>,
  envelope: SafeEventEnvelope,
  pseudonyms?: SafeEventPseudonyms,
): SafeEvent {
  return SafeEvent.parse({
    ...envelope,
    kind: "approval_wait",
    decision: event.decision,
    decidedBy: event.decidedBy,
    ...(pseudonyms?.approverId === undefined
      ? {}
      : { approverPseudonym: pseudonyms.approverId }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    waitMs: event.waitMs,
  });
}

function projectCheckpoint(
  event: Extract<Event, { type: "checkpoint_written" }>,
  envelope: SafeEventEnvelope,
): SafeEvent {
  return SafeEvent.parse({
    ...envelope,
    kind: "checkpoint",
    atSeq: event.atSeq,
    hasWorkspaceRef: event.workspaceRef !== undefined,
  });
}

function projectRunStatus(
  event: Extract<Event, { type: "run_status_changed" }>,
  envelope: SafeEventEnvelope,
): SafeEvent {
  return SafeEvent.parse({
    ...envelope,
    kind: "run_status",
    from: event.from,
    to: event.to,
    reason: event.reason,
  });
}

function projectPiiAction(
  event: Extract<Event, { type: "pii_action" }>,
  envelope: SafeEventEnvelope,
): SafeEvent {
  return SafeEvent.parse({
    ...envelope,
    kind: "pii_action",
    boundary: event.boundary,
    action: event.action,
    ...(event.toolId === undefined ? {} : { toolId: event.toolId }),
    entities: event.entities.map(({ type, count }) => ({ type, count })),
  });
}

function projectBudgetExceeded(
  event: Extract<Event, { type: "budget_exceeded" }>,
  envelope: SafeEventEnvelope,
): SafeEvent {
  return SafeEvent.parse({
    ...envelope,
    kind: "budget_exceeded",
    budget: event.budget,
    limit: event.limit,
    observed: event.observed,
  });
}

function projectSubagentSpawned(
  event: Extract<Event, { type: "subagent_spawned" }>,
  envelope: SafeEventEnvelope,
): SafeEvent {
  return SafeEvent.parse({
    ...envelope,
    kind: "subagent_spawned",
    childRunId: event.childRunId,
    role: event.role,
    ...(event.parentCallId === undefined ? {} : { parentCallId: event.parentCallId }),
  });
}

function projectSubagentCompleted(
  event: Extract<Event, { type: "subagent_completed" }>,
  envelope: SafeEventEnvelope,
): SafeEvent {
  return SafeEvent.parse({
    ...envelope,
    kind: "subagent_completed",
    childRunId: event.childRunId,
    outcome: event.outcome,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.costMicros === undefined ? {} : { costMicros: event.costMicros }),
  });
}

function projectRunCreated(
  event: Extract<Event, { type: "run_created" }>,
  envelope: SafeEventEnvelope,
  pseudonyms?: SafeEventPseudonyms,
): SafeEvent {
  // The shared policyVersion is the exporter's sanitizer version, not the source run version.
  return SafeEvent.parse({
    ...envelope,
    kind: "run_created",
    configHash: event.configHash,
    ...(pseudonyms?.requestedBy === undefined
      ? {}
      : { requestedByPseudonym: pseudonyms.requestedBy }),
  });
}

/**
 * Project an event to its explicit telemetry-safe allowlist.
 *
 * @param event - Validated stored event.
 * @param policyVersion - Current sanitizer policy version used by the exporter.
 * @returns The safe event, or `null` when the event type is not exported.
 */
export function toSafeEvent(
  event: Event,
  policyVersion: EventCode,
  pseudonyms?: SafeEventPseudonyms,
): SafeEvent | null {
  const envelope = createEnvelope(event, policyVersion);
  if (isUnexportedEvent(event)) {
    return null;
  }

  switch (event.type) {
    case "model_response":
      return projectModelResponse(event, envelope);
    case "tool_result":
      return projectToolResult(event, envelope);
    case "tool_intent":
      return projectToolIntent(event, envelope);
    case "approval_resolved":
      return projectApprovalResolved(event, envelope, pseudonyms);
    case "checkpoint_written":
      return projectCheckpoint(event, envelope);
    case "run_status_changed":
      return projectRunStatus(event, envelope);
    case "pii_action":
      return projectPiiAction(event, envelope);
    case "budget_exceeded":
      return projectBudgetExceeded(event, envelope);
    case "subagent_spawned":
      return projectSubagentSpawned(event, envelope);
    case "subagent_completed":
      return projectSubagentCompleted(event, envelope);
    case "run_created":
      return projectRunCreated(event, envelope, pseudonyms);
    default: {
      const exhaustiveEvent: never = event;
      return exhaustiveEvent;
    }
  }
}
