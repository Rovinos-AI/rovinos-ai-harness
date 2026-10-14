// SPDX-License-Identifier: Apache-2.0
import { metrics, type Attributes, type Counter, type Meter } from "@opentelemetry/api";
import type { Code } from "@harness/schemas";

type NoMetricAttributes = Readonly<Record<string, never>>;

/** Closed reason values used by the dropped-telemetry metric. */
export const TELEMETRY_DROP_REASONS = [
  "unregistered_span",
  "unregistered_log_record",
  "unregistered_attr",
  "invalid_attr",
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
] as const;

/** Policy outcomes used by the decision counter. */
export const POLICY_DECISIONS = ["allow", "ask", "deny"] as const;

/** Bounded reasons for dropping or stripping telemetry data. */
export type TelemetryDropReason = (typeof TELEMETRY_DROP_REASONS)[number];
/** Bounded reasons counted when an app call is rejected by the host. */
export type HostAppRejectedReason = (typeof HOST_APP_REJECTED_REASONS)[number];
/** Bounded policy decision outcome. */
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];
interface TelemetryDropAttributes extends Readonly<Record<string, TelemetryDropReason>> {
  readonly "harness.telemetry.dropped.reason": TelemetryDropReason;
}
interface HostAppRejectedAttributes extends Readonly<Record<string, HostAppRejectedReason>> {
  readonly "harness.host.app_rejected.reason": HostAppRejectedReason;
}
interface PolicyDecisionAttributes extends Readonly<Record<string, PolicyDecision>> {
  readonly "harness.policy.decision": PolicyDecision;
}

/** String-valued metric attributes are explicitly closed enumerations. */
export const TELEMETRY_METRIC_STRING_ATTRIBUTES = {
  "harness.telemetry.dropped.reason": TELEMETRY_DROP_REASONS,
  "harness.host.app_rejected.reason": HOST_APP_REJECTED_REASONS,
  "harness.policy.decision": POLICY_DECISIONS,
} as const;

/** Collector allowlist of metric names and their allowed datapoint attribute keys. */
export const METRIC_ALLOWLIST = {
  "harness.host.app_rejected": ["harness.host.app_rejected.reason"],
  "harness.host.app_spans_accepted": [],
  "harness.policy.decisions": ["harness.policy.decision"],
  "harness.sentinel.scope_reduced": [],
  "harness.sentinel.short_values_skipped": [],
  "harness.telemetry.dropped": ["harness.telemetry.dropped.reason"],
} as const satisfies Record<Code, readonly Code[]>;

let droppedCounter: Counter<TelemetryDropAttributes> | undefined;
let hostAppRejectedCounter: Counter<HostAppRejectedAttributes> | undefined;
let policyDecisionsCounter: Counter<PolicyDecisionAttributes> | undefined;
let hostAppSpansAcceptedCounter: Counter<NoMetricAttributes> | undefined;
let skippedShortValuesCounter: Counter<NoMetricAttributes> | undefined;
let scopeReducedCounter: Counter<NoMetricAttributes> | undefined;

function createCounter<TAttributes extends Attributes>(
  name: keyof typeof METRIC_ALLOWLIST,
  factory: (meter: Meter, name: keyof typeof METRIC_ALLOWLIST) => Counter<TAttributes>,
): Counter<TAttributes> {
  return factory(metrics.getMeter("@harness/telemetry"), name);
}

function getDroppedCounter(): Counter<TelemetryDropAttributes> {
  droppedCounter ??= createCounter<TelemetryDropAttributes>(
    "harness.telemetry.dropped",
    (meter, name) => meter.createCounter<TelemetryDropAttributes>(name),
  );
  return droppedCounter;
}

function getHostAppRejectedCounter(): Counter<HostAppRejectedAttributes> {
  hostAppRejectedCounter ??= createCounter<HostAppRejectedAttributes>(
    "harness.host.app_rejected",
    (meter, name) => meter.createCounter<HostAppRejectedAttributes>(name),
  );
  return hostAppRejectedCounter;
}

function getPolicyDecisionsCounter(): Counter<PolicyDecisionAttributes> {
  policyDecisionsCounter ??= createCounter<PolicyDecisionAttributes>(
    "harness.policy.decisions",
    (meter, name) => meter.createCounter<PolicyDecisionAttributes>(name),
  );
  return policyDecisionsCounter;
}

function getHostAppSpansAcceptedCounter(): Counter<NoMetricAttributes> {
  hostAppSpansAcceptedCounter ??= createCounter<NoMetricAttributes>(
    "harness.host.app_spans_accepted",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return hostAppSpansAcceptedCounter;
}

function getSkippedShortValuesCounter(): Counter<NoMetricAttributes> {
  skippedShortValuesCounter ??= createCounter<NoMetricAttributes>(
    "harness.sentinel.short_values_skipped",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return skippedShortValuesCounter;
}

function getScopeReducedCounter(): Counter<NoMetricAttributes> {
  scopeReducedCounter ??= createCounter<NoMetricAttributes>(
    "harness.sentinel.scope_reduced",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return scopeReducedCounter;
}

/** Counts a telemetry drop using its bounded reason code. */
export function countDroppedTelemetry(reason: TelemetryDropReason): void {
  try {
    getDroppedCounter().add(1, { "harness.telemetry.dropped.reason": reason });
  } catch {
    return;
  }
}

/** Counts an app tool rejection with its bounded host reason code. */
export function countHostAppRejected(reason: HostAppRejectedReason): void {
  try {
    getHostAppRejectedCounter().add(1, { "harness.host.app_rejected.reason": reason });
  } catch {
    return;
  }
}

/** Counts one policy decision using its bounded outcome. */
export function countPolicyDecision(decision: PolicyDecision): void {
  try {
    getPolicyDecisionsCounter().add(1, { "harness.policy.decision": decision });
  } catch {
    return;
  }
}

/** Counts accepted app spans without high-cardinality attributes. */
export function countHostAppSpansAccepted(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0) {
    return;
  }
  try {
    getHostAppSpansAcceptedCounter().add(count);
  } catch {
    return;
  }
}

/** Counts values excluded from a run's sentinel set without metric attributes. */
export function countSkippedShortValues(count: number): void {
  try {
    getSkippedShortValuesCounter().add(count);
  } catch {
    return;
  }
}

/** Counts when a global scan uses per-run matchers instead of a combined matcher. */
export function countSentinelScopeReduced(): void {
  try {
    getScopeReducedCounter().add(1);
  } catch {
    return;
  }
}
