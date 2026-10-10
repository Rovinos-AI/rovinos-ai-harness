// SPDX-License-Identifier: Apache-2.0
import { metrics, type Counter } from "@opentelemetry/api";

/** Bounded reasons for dropping or stripping telemetry data. */
export type TelemetryDropReason =
  | "unregistered_span"
  | "unregistered_attr"
  | "invalid_attr"
  | "event_stripped"
  | "leak_sentinel"
  | "processor_error";

let droppedCounter: Counter<{ readonly reason: TelemetryDropReason }> | undefined;
let skippedShortValuesCounter: Counter | undefined;

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
