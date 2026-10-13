// SPDX-License-Identifier: Apache-2.0
import { metrics, type Counter } from "@opentelemetry/api";

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
] as const;

/** Closed rejection reasons used by the host app-call counter. */
export const HOST_APP_REJECTED_REASONS = ["unknown_tool"] as const;

/** Bounded reasons for dropping or stripping telemetry data. */
export type TelemetryDropReason = (typeof TELEMETRY_DROP_REASONS)[number];
/** Bounded reasons counted when an app call is rejected by the host. */
export type HostAppRejectedReason = (typeof HOST_APP_REJECTED_REASONS)[number];
interface TelemetryDropAttributes extends Readonly<Record<string, TelemetryDropReason>> {
  readonly reason: TelemetryDropReason;
}
interface HostAppRejectedAttributes extends Readonly<Record<string, HostAppRejectedReason>> {
  readonly reason: HostAppRejectedReason;
}

/** String-valued metric attributes are explicitly closed enumerations. */
export const TELEMETRY_METRIC_STRING_ATTRIBUTES = {
  "harness.telemetry.dropped.reason": TELEMETRY_DROP_REASONS,
  "harness.host.app_rejected.reason": HOST_APP_REJECTED_REASONS,
} as const;

let droppedCounter: Counter<TelemetryDropAttributes> | undefined;
let hostAppRejectedCounter: Counter<HostAppRejectedAttributes> | undefined;
let skippedShortValuesCounter: Counter<NoMetricAttributes> | undefined;
let scopeReducedCounter: Counter<NoMetricAttributes> | undefined;

function getDroppedCounter(): Counter<TelemetryDropAttributes> {
  droppedCounter ??= metrics
    .getMeter("@harness/telemetry")
    .createCounter<TelemetryDropAttributes>("harness.telemetry.dropped");
  return droppedCounter;
}

function getHostAppRejectedCounter(): Counter<HostAppRejectedAttributes> {
  hostAppRejectedCounter ??= metrics
    .getMeter("@harness/telemetry")
    .createCounter<HostAppRejectedAttributes>("harness.host.app_rejected");
  return hostAppRejectedCounter;
}

function getSkippedShortValuesCounter(): Counter<NoMetricAttributes> {
  skippedShortValuesCounter ??= metrics
    .getMeter("@harness/telemetry")
    .createCounter<NoMetricAttributes>("harness.sentinel.short_values_skipped");
  return skippedShortValuesCounter;
}

function getScopeReducedCounter(): Counter<NoMetricAttributes> {
  scopeReducedCounter ??= metrics
    .getMeter("@harness/telemetry")
    .createCounter<NoMetricAttributes>("harness.sentinel.scope_reduced");
  return scopeReducedCounter;
}

/** Counts a telemetry drop using its bounded reason code. */
export function countDroppedTelemetry(reason: TelemetryDropReason): void {
  try {
    getDroppedCounter().add(1, { reason });
  } catch {
    return;
  }
}

/** Counts an app tool rejection with its bounded host reason code. */
export function countHostAppRejected(reason: HostAppRejectedReason): void {
  try {
    getHostAppRejectedCounter().add(1, { reason });
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
