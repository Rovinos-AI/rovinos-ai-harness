// SPDX-License-Identifier: Apache-2.0

/** Keeps telemetry instrumentation failures from affecting application behavior. */
export function safelyRecordMetric(record: () => void): void {
  try {
    record();
  } catch {
    return;
  }
}
