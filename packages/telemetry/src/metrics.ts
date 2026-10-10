// SPDX-License-Identifier: Apache-2.0
import { metrics, type Counter } from "@opentelemetry/api";

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

/** String-valued metric attributes are explicitly closed enumerations. */
export const TELEMETRY_METRIC_STRING_ATTRIBUTES = {
  "harness.telemetry.dropped.reason": TELEMETRY_DROP_REASONS,
} as const;

let droppedCounter: Counter<{ readonly reason: TelemetryDropReason }> | undefined;
let skippedShortValuesCounter: Counter | undefined;
let scopeReducedCounter: Counter | undefined;

function getDroppedCounter(): Counter<{ readonly reason: TelemetryDropReason }> {
  droppedCounter ??= metrics
    .getMeter("@harness/telemetry")
    .createCounter<{ readonly reason: TelemetryDropReason }>("harness.telemetry.dropped");
  return droppedCounter;
}

function getSkippedShortValuesCounter(): Counter {
  skippedShortValuesCounter ??= metrics
    .getMeter("@harness/telemetry")
    .createCounter("harness.sentinel.short_values_skipped");
  return skippedShortValuesCounter;
}

function getScopeReducedCounter(): Counter {
  scopeReducedCounter ??= metrics
    .getMeter("@harness/telemetry")
    .createCounter("harness.sentinel.scope_reduced");
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
