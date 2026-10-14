// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, trace } from "@opentelemetry/api";
import { logs, SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { Code } from "@harness/schemas";
import { attr } from "./attr.js";
import { defineLogRecord, type LogRecordDefinition } from "./log-registry.js";
import { SafeEvent, type SafeEvent as SafeEventType } from "./safe-event.js";

const commonShape = {
  "harness.run.id": attr.id(),
  "harness.event.seq": attr.nonnegativeInt(),
  "harness.event.timestamp_ms": attr.nonnegativeInt(),
  "harness.policy.version": attr.code(),
  "harness.trace.id": attr.code(),
  "harness.span.id": attr.code(),
};

/** SafeEvent fields mapped to bounded OpenTelemetry attribute names. */
export const safeEventLogAttributeMap = {
  model_call: {
    runId: "harness.run.id",
    seq: "harness.event.seq",
    ts: "harness.event.timestamp_ms",
    policyVersion: "harness.policy.version",
    traceId: "harness.trace.id",
    spanId: "harness.span.id",
    provider: "harness.model.provider",
    model: "harness.model.name",
    inputTokens: "harness.model.input_tokens",
    outputTokens: "harness.model.output_tokens",
    latencyMs: "harness.model.latency_ms",
    schemaValid: "harness.model.schema_valid",
    repairAttempts: "harness.model.repair_attempts",
    finishReason: "harness.model.finish_reason",
  },
  tool_call: {
    runId: "harness.run.id",
    seq: "harness.event.seq",
    ts: "harness.event.timestamp_ms",
    policyVersion: "harness.policy.version",
    traceId: "harness.trace.id",
    spanId: "harness.span.id",
    toolId: "harness.tool.id",
    outcome: "harness.tool.outcome",
    errorCode: "harness.error.code",
    latencyMs: "harness.tool.latency_ms",
  },
  approval_wait: {
    runId: "harness.run.id",
    seq: "harness.event.seq",
    ts: "harness.event.timestamp_ms",
    policyVersion: "harness.policy.version",
    traceId: "harness.trace.id",
    spanId: "harness.span.id",
    decision: "harness.approval.decision",
    waitMs: "harness.approval.wait_ms",
  },
  checkpoint: {
    runId: "harness.run.id",
    seq: "harness.event.seq",
    ts: "harness.event.timestamp_ms",
    policyVersion: "harness.policy.version",
    traceId: "harness.trace.id",
    spanId: "harness.span.id",
    atSeq: "harness.checkpoint.seq",
    hasWorkspaceRef: "harness.checkpoint.has_workspace_ref",
  },
  run_status: {
    runId: "harness.run.id",
    seq: "harness.event.seq",
    ts: "harness.event.timestamp_ms",
    policyVersion: "harness.policy.version",
    traceId: "harness.trace.id",
    spanId: "harness.span.id",
    from: "harness.run.status.from",
    to: "harness.run.status.to",
    reason: "harness.run.status.reason",
  },
  pii_action: {
    runId: "harness.run.id",
    seq: "harness.event.seq",
    ts: "harness.event.timestamp_ms",
    policyVersion: "harness.policy.version",
    traceId: "harness.trace.id",
    spanId: "harness.span.id",
    boundary: "harness.pii.boundary",
    action: "harness.pii.action",
    entities: "harness.pii.entity_count",
  },
  budget_exceeded: {
    runId: "harness.run.id",
    seq: "harness.event.seq",
    ts: "harness.event.timestamp_ms",
    policyVersion: "harness.policy.version",
    traceId: "harness.trace.id",
    spanId: "harness.span.id",
    budget: "harness.budget.kind",
    limit: "harness.budget.limit",
    observed: "harness.budget.observed",
  },
  subagent_spawned: {
    runId: "harness.run.id",
    seq: "harness.event.seq",
    ts: "harness.event.timestamp_ms",
    policyVersion: "harness.policy.version",
    traceId: "harness.trace.id",
    spanId: "harness.span.id",
    childRunId: "harness.subagent.run.id",
    role: "harness.subagent.role",
    parentCallId: "harness.subagent.parent_call.id",
  },
  subagent_completed: {
    runId: "harness.run.id",
    seq: "harness.event.seq",
    ts: "harness.event.timestamp_ms",
    policyVersion: "harness.policy.version",
    traceId: "harness.trace.id",
    spanId: "harness.span.id",
    childRunId: "harness.subagent.run.id",
    outcome: "harness.subagent.outcome",
  },
  run_created: {
    runId: "harness.run.id",
    seq: "harness.event.seq",
    ts: "harness.event.timestamp_ms",
    policyVersion: "harness.policy.version",
    traceId: "harness.trace.id",
    spanId: "harness.span.id",
    configHash: "harness.run.config_hash",
  },
} as const satisfies Record<SafeEventType["kind"], Readonly<Record<string, string>>>;

const logDefinitions = {
  model_call: defineLogRecord("harness.safe.model_call", {
    ...commonShape,
    "harness.model.provider": attr.code(),
    "harness.model.name": attr.code(),
    "harness.model.input_tokens": attr.nonnegativeInt(),
    "harness.model.output_tokens": attr.nonnegativeInt(),
    "harness.model.latency_ms": attr.nonnegativeInt(),
    "harness.model.schema_valid": attr.bool(),
    "harness.model.repair_attempts": attr.nonnegativeInt(),
    "harness.model.finish_reason": attr.code(),
  }),
  tool_call: defineLogRecord("harness.safe.tool_call", {
    ...commonShape,
    "harness.tool.id": attr.code(),
    "harness.tool.outcome": attr.enum(["ok", "error", "denied", "timeout"]),
    "harness.error.code": attr.optional(attr.code()),
    "harness.tool.latency_ms": attr.nonnegativeInt(),
  }),
  approval_wait: defineLogRecord("harness.safe.approval_wait", {
    ...commonShape,
    "harness.approval.decision": attr.enum(["approve", "deny", "edit"]),
    "harness.approval.wait_ms": attr.nonnegativeInt(),
  }),
  checkpoint: defineLogRecord("harness.safe.checkpoint", {
    ...commonShape,
    "harness.checkpoint.seq": attr.nonnegativeInt(),
    "harness.checkpoint.has_workspace_ref": attr.bool(),
  }),
  run_status: defineLogRecord("harness.safe.run_status", {
    ...commonShape,
    "harness.run.status.from": attr.enum([
      "pending",
      "running",
      "suspended",
      "completed",
      "failed",
      "cancelled",
    ]),
    "harness.run.status.to": attr.enum([
      "pending",
      "running",
      "suspended",
      "completed",
      "failed",
      "cancelled",
    ]),
    "harness.run.status.reason": attr.code(),
  }),
  pii_action: defineLogRecord("harness.safe.pii_action", {
    ...commonShape,
    "harness.pii.boundary": attr.enum([
      "model_input",
      "tool_input",
      "tool_output",
      "storage",
      "ui",
    ]),
    "harness.pii.action": attr.enum(["tokenized", "redacted", "blocked", "allowed", "detokenized"]),
    "harness.pii.entity_count": attr.nonnegativeInt(),
  }),
  budget_exceeded: defineLogRecord("harness.safe.budget_exceeded", {
    ...commonShape,
    "harness.budget.kind": attr.enum(["steps", "cost", "wall_clock"]),
    "harness.budget.limit": attr.num(),
    "harness.budget.observed": attr.num(),
  }),
  subagent_spawned: defineLogRecord("harness.safe.subagent_spawned", {
    ...commonShape,
    "harness.subagent.run.id": attr.id(),
    "harness.subagent.role": attr.code(),
    "harness.subagent.parent_call.id": attr.optional(attr.id()),
  }),
  subagent_completed: defineLogRecord("harness.safe.subagent_completed", {
    ...commonShape,
    "harness.subagent.run.id": attr.id(),
    "harness.subagent.outcome": attr.enum(["completed", "failed", "cancelled"]),
  }),
  run_created: defineLogRecord("harness.safe.run_created", {
    ...commonShape,
    "harness.run.config_hash": attr.hash(),
  }),
} satisfies Record<SafeEventType["kind"], LogRecordDefinition>;

const safeEventLogger = logs.getLogger("@harness/core");

function scalarValue(value: unknown): string | number | boolean | undefined {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  return undefined;
}

function readEventField(event: SafeEventType, field: string): unknown {
  if (field !== "entities") {
    return Reflect.get(event, field);
  }

  // Entity arrays are not OTel scalar attributes; preserve only their safe aggregate count.
  const entities: unknown = Reflect.get(event, field);
  if (!Array.isArray(entities)) {
    return undefined;
  }
  return entities.reduce<number>((total, entity: unknown) => {
    if (typeof entity !== "object" || entity === null || !("count" in entity)) {
      return total;
    }
    const count: unknown = Reflect.get(entity, "count");
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? total + count
      : total;
  }, 0);
}

/**
 * Emits a validated SafeEvent as a metadata-only OpenTelemetry log record.
 *
 * @param logger - OpenTelemetry logger from the logs API.
 * @param safeEvent - SafeEvent previously projected by `toSafeEvent`.
 */
export function emitSafeEvent(logger: Logger, safeEvent: SafeEventType): void {
  const event = SafeEvent.parse(safeEvent);
  const definition = logDefinitions[event.kind];
  const attributes: Record<string, string | number | boolean> = {};
  for (const [field, name] of Object.entries(safeEventLogAttributeMap[event.kind])) {
    const value = scalarValue(readEventField(event, field));
    if (value !== undefined) {
      attributes[name] = value;
    }
  }

  logger.emit({
    body: Code.parse(event.kind),
    eventName: definition.name,
    severityNumber: SeverityNumber.INFO,
    attributes: definition.schema.parse(attributes),
    context: trace.setSpanContext(otelContext.active(), {
      traceId: event.traceId,
      spanId: event.spanId,
      traceFlags: 0,
    }),
  });
}

/** Emits a validated SafeEvent through the harness logger without exposing OTel to callers. */
export function emitSafeEventToDefaultLogger(safeEvent: SafeEventType): void {
  emitSafeEvent(safeEventLogger, safeEvent);
}
