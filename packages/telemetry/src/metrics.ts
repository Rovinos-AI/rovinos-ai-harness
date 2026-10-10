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

/** Bounded reasons for dropping or stripping telemetry data. */
export type TelemetryDropReason = (typeof TELEMETRY_DROP_REASONS)[number];
interface TelemetryDropAttributes extends Readonly<Record<string, TelemetryDropReason>> {
  readonly reason: TelemetryDropReason;
}

/** String-valued metric attributes are explicitly closed enumerations. */
export const TELEMETRY_METRIC_STRING_ATTRIBUTES = {
  "harness.telemetry.dropped.reason": TELEMETRY_DROP_REASONS,
} as const;

let droppedCounter: Counter<TelemetryDropAttributes> | undefined;
let skippedShortValuesCounter: Counter<NoMetricAttributes> | undefined;
let scopeReducedCounter: Counter<NoMetricAttributes> | undefined;

function getDroppedCounter(): Counter<TelemetryDropAttributes> {
  droppedCounter ??= metrics
    .getMeter("@harness/telemetry")
    .createCounter<TelemetryDropAttributes>("harness.telemetry.dropped");
  return droppedCounter;
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
