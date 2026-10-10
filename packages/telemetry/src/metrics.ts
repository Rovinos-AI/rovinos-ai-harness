// SPDX-License-Identifier: Apache-2.0
import { metrics, type Counter } from "@opentelemetry/api";

/** Bounded reasons for dropping or stripping telemetry data. */
export type TelemetryDropReason =
  | "unregistered_span"
  | "unregistered_log_record"
  | "unregistered_attr"
  | "invalid_attr"
  | "event_stripped"
  | "leak_sentinel"
  | "processor_error";

let droppedCounter: Counter<{ readonly reason: TelemetryDropReason }> | undefined;

function getDroppedCounter(): Counter<{ readonly reason: TelemetryDropReason }> {
  droppedCounter ??= metrics
    .getMeter("@harness/telemetry")
    .createCounter<{ readonly reason: TelemetryDropReason }>("harness.telemetry.dropped");
  return droppedCounter;
}

/** Counts a telemetry drop using its bounded reason code. */
export function countDroppedTelemetry(reason: TelemetryDropReason): void {
  try {
    getDroppedCounter().add(1, { reason });
  } catch {
    return;
  }
}
