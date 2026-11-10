// SPDX-License-Identifier: Apache-2.0
import type { Code } from "@rovinos/schemas";

/** Closed reason values used by the dropped-telemetry metric. */
export const TELEMETRY_DROP_REASONS = [
  "unregistered_span",
  "unregistered_log_record",
  "unregistered_attr",
  "invalid_attr",
  "correlation_disabled",
  "event_stripped",
  "leak_sentinel",
  "processor_error",
  "trip_queue_overflow",
  "trip_append_failed",
  "trip_flush_failed",
  "trip_discarded",
] as const;

/** Closed rejection reasons used by the host app-call counter. */
export const HOST_APP_REJECTED_REASONS = [
  "schema",
  "size",
  "rate",
  "unknown_app",
  "unknown_tool",
  "unknown_span",
  "session_cap",
  "request_disabled",
  "request_invalid",
  "request_unavailable",
  "user_denied",
] as const;

/** Policy outcomes used by the decision counter. */
export const POLICY_DECISIONS = ["allow", "ask", "deny"] as const;
/** Bounded outcomes for MCP human-input requests. */
export const MCP_INPUT_REQUEST_OUTCOMES = [
  "asked",
  "declined_sensitive",
  "rejected",
  "rounds_exceeded",
  "rate_limited",
] as const;
/** Closed worker job outcomes used by the worker counter. */
export const WORKER_JOB_OUTCOMES = ["completed", "suspended", "failed", "lease_lost"] as const;
/** Rate-limit key classes emitted as bounded metric attributes. */
export const RATE_LIMIT_KEY_KINDS = ["provider", "control_plane"] as const;
/** Shared rate-limit backends emitted as bounded metric attributes. */
export const RATE_LIMIT_BACKENDS = ["postgres", "redis"] as const;
/** Terminal run outcomes used by the completed-run counter. */
export const RUN_COMPLETION_OUTCOMES = ["completed", "failed", "cancelled"] as const;
/** Human approval decisions used by the approval wait histogram. */
export const APPROVAL_DECISIONS = ["approve", "deny", "edit"] as const;
/** Recorded tool outcomes used by the tool-call counter. */
export const TOOL_CALL_OUTCOMES = ["ok", "error", "denied", "timeout"] as const;

/** Bounded reasons for dropping or stripping telemetry data. */
export type TelemetryDropReason = (typeof TELEMETRY_DROP_REASONS)[number];
/** Bounded reasons counted when an app call is rejected by the host. */
export type HostAppRejectedReason = (typeof HOST_APP_REJECTED_REASONS)[number];
/** Bounded policy decision outcome. */
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];
/** Bounded outcomes counted for an MCP human-input request. */
export type McpInputRequestOutcome = (typeof MCP_INPUT_REQUEST_OUTCOMES)[number];
/** Bounded worker job outcome. */
export type WorkerJobOutcome = (typeof WORKER_JOB_OUTCOMES)[number];
/** Bounded provider or control-plane rate-limit key class. */
export type RateLimitKeyKind = (typeof RATE_LIMIT_KEY_KINDS)[number];
/** Bounded shared rate-limit backend. */
export type RateLimitBackend = (typeof RATE_LIMIT_BACKENDS)[number];
/** Bounded terminal run outcome. */
export type RunCompletionOutcome = (typeof RUN_COMPLETION_OUTCOMES)[number];
/** Bounded approval decision. */
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
/** Bounded recorded tool outcome. */
export type ToolCallOutcome = (typeof TOOL_CALL_OUTCOMES)[number];

/** Attributes emitted by the dropped-telemetry counter. */
export interface TelemetryDropAttributes extends Readonly<Record<string, TelemetryDropReason>> {
  readonly "harness.telemetry.dropped.reason": TelemetryDropReason;
}
/** Attributes emitted by the host app-call rejection counter. */
export interface HostAppRejectedAttributes extends Readonly<Record<string, HostAppRejectedReason>> {
  readonly "harness.host.app_rejected.reason": HostAppRejectedReason;
}
/** Attributes emitted by the policy decision counter. */
export interface PolicyDecisionAttributes extends Readonly<Record<string, PolicyDecision>> {
  readonly "harness.policy.decision": PolicyDecision;
}
/** Attributes emitted by model usage metrics. */
export interface ModelUsageAttributes extends Readonly<Record<string, Code>> {
  readonly "harness.model.provider": Code;
  readonly "harness.model.name": Code;
}
interface QuotaRejectionAttribute extends Readonly<Record<string, Code>> {
  readonly "harness.quota.id": Code;
}
/** Attributes emitted by shared rate-limit denial metrics. */
export interface RateLimitDeniedAttributes extends Readonly<Record<string, RateLimitKeyKind>> {
  readonly "harness.rate_limit.denied.key_kind": RateLimitKeyKind;
}
/** Attributes emitted when the shared rate-limit backend degrades. */
export interface RateLimitDegradedAttributes extends Readonly<Record<string, RateLimitBackend>> {
  readonly "harness.rate_limit.degraded.backend": RateLimitBackend;
}
/** Attributes emitted by quota rejection and shared rate-limit counters. */
export type QuotaRejectionAttributes =
  QuotaRejectionAttribute | RateLimitDeniedAttributes | RateLimitDegradedAttributes;
/** Attributes emitted by the MCP input request counter. */
export interface McpInputRequestAttributes extends Readonly<
  Record<string, McpInputRequestOutcome>
> {
  readonly "harness.mcp.input_requests.outcome": McpInputRequestOutcome;
}
/** Attributes emitted by the worker job counter. */
export interface WorkerJobAttributes extends Readonly<Record<string, WorkerJobOutcome>> {
  readonly "harness.worker.jobs.outcome": WorkerJobOutcome;
}
/** Attributes emitted by the completed-run counter. */
export interface RunCompletedAttributes extends Readonly<Record<string, RunCompletionOutcome>> {
  readonly "harness.run.completed.outcome": RunCompletionOutcome;
}
/** Attributes emitted by the approval-wait histogram. */
export interface ApprovalWaitAttributes extends Readonly<Record<string, ApprovalDecision>> {
  readonly "harness.approval.wait_ms.decision": ApprovalDecision;
}
/** Attributes emitted by the tool-call counter. */
export interface ToolCallAttributes extends Readonly<Record<string, ToolCallOutcome>> {
  readonly "harness.tool.calls.outcome": ToolCallOutcome;
}

/** String-valued metric attributes are explicitly closed enumerations. */
export const TELEMETRY_METRIC_STRING_ATTRIBUTES = {
  "harness.telemetry.dropped.reason": TELEMETRY_DROP_REASONS,
  "harness.host.app_rejected.reason": HOST_APP_REJECTED_REASONS,
  "harness.policy.decision": POLICY_DECISIONS,
  "harness.mcp.input_requests.outcome": MCP_INPUT_REQUEST_OUTCOMES,
  "harness.worker.jobs.outcome": WORKER_JOB_OUTCOMES,
  "harness.rate_limit.denied.key_kind": RATE_LIMIT_KEY_KINDS,
  "harness.rate_limit.degraded.backend": RATE_LIMIT_BACKENDS,
  "harness.run.completed.outcome": RUN_COMPLETION_OUTCOMES,
  "harness.approval.wait_ms.decision": APPROVAL_DECISIONS,
  "harness.tool.calls.outcome": TOOL_CALL_OUTCOMES,
} as const satisfies Record<Code, readonly Code[]>;

/** Collector allowlist of metric names and their allowed datapoint attribute keys. */
export const METRIC_ALLOWLIST = {
  "harness.host.app_rejected": ["harness.host.app_rejected.reason"],
  "harness.host.app_spans_accepted": [],
  "harness.model.cache_read_tokens": ["harness.model.provider", "harness.model.name"],
  "harness.model.cache_write_tokens": ["harness.model.provider", "harness.model.name"],
  "harness.model.tokens": ["harness.model.provider", "harness.model.name"],
  "harness.model.cost_micros": ["harness.model.provider", "harness.model.name"],
  "harness.policy.decisions": ["harness.policy.decision"],
  "harness.quota.rejections": ["harness.quota.id"],
  "harness.pii.blob_hit": [],
  "harness.pii.detector_degraded": [],
  "harness.sentinel.scope_reduced": [],
  "harness.sentinel.short_values_skipped": [],
  "harness.telemetry.dropped": ["harness.telemetry.dropped.reason"],
  "harness.mcp.discovery_failed": [],
  "harness.mcp.input_requests": ["harness.mcp.input_requests.outcome"],
  "harness.worker.jobs": ["harness.worker.jobs.outcome"],
  "harness.rate_limit.denied": ["harness.rate_limit.denied.key_kind"],
  "harness.rate_limit.degraded": ["harness.rate_limit.degraded.backend"],
  "harness.worker.queue_lag_ms": [],
  "harness.run.completed": ["harness.run.completed.outcome"],
  "harness.model.latency_ms": ["harness.model.provider", "harness.model.name"],
  "harness.approval.wait_ms": ["harness.approval.wait_ms.decision"],
  "harness.tool.calls": ["harness.tool.calls.outcome"],
} as const;
