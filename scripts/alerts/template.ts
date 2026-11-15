// SPDX-License-Identifier: Apache-2.0
// Use safe event logs for signals without a registered metric; do not add runtime telemetry here.
import type { AlertId, AlertThreshold, AlertThresholds, DatadogMonitor } from "./contracts.ts";

interface MonitorTemplate {
  readonly id: AlertId;
  readonly name: string;
  readonly type: DatadogMonitor["type"];
  readonly runbook: string;
  readonly tags: readonly string[];
  readonly description: string;
  readonly query: (threshold: AlertThreshold) => string;
}

const monitorTemplates = [
  {
    id: "leak_sentinel",
    name: "Harness leak sentinel tripped",
    type: "metric alert",
    runbook: "docs/runbooks/leak-sentinel.md#suspected-telemetry-leak",
    tags: ["service:harness", "signal:privacy"],
    description: "Page on any nonzero leak-sentinel drop count.",
    query: ({ window_minutes, critical }) =>
      `sum(last_${String(window_minutes)}m):sum:harness.telemetry.dropped{harness.telemetry.dropped.reason:leak_sentinel}.as_count() > ${String(critical)}`,
  },
  {
    id: "rejected_app_spans",
    name: "Harness rejected app spans",
    type: "metric alert",
    runbook: "docs/runbooks/rejected-app-spans.md#rejected-app-spans",
    tags: ["service:harness", "signal:application"],
    description: "Counts rejected application spans over the configured window.",
    query: ({ window_minutes, critical }) =>
      `sum(last_${String(window_minutes)}m):sum:harness.host.app_rejected{*}.as_count() > ${String(critical)}`,
  },
  {
    id: "pii_detector_degraded",
    name: "Harness PII detector degraded",
    type: "metric alert",
    runbook: "docs/runbooks/pii-detector-degraded.md#pii-detector-degraded",
    tags: ["service:harness", "signal:privacy"],
    description: "Counts PII detector degradation events over the configured window.",
    query: ({ window_minutes, critical }) =>
      `sum(last_${String(window_minutes)}m):sum:harness.pii.detector_degraded{*}.as_count() > ${String(critical)}`,
  },
  {
    id: "budget_exceeded",
    name: "Harness budget-exceeded runs",
    type: "log alert",
    runbook: "docs/runbooks/budget-exceeded.md#budget-exceeded",
    tags: ["service:harness", "signal:budget"],
    description: "Counts metadata-only budget-exceeded events over the configured window.",
    query: ({ window_minutes, critical }) =>
      `logs("@message:harness.safe.budget_exceeded").index("*").rollup("count").last("${String(window_minutes)}m") > ${String(critical)}`,
  },
  {
    id: "approval_wait",
    name: "Harness approval wait p95",
    type: "metric alert",
    runbook: "docs/runbooks/approval-wait.md#approval-wait",
    tags: ["service:harness", "signal:approval"],
    description:
      "Pages when approval wait p95 exceeds the configured threshold; review expiry decisions separately.",
    query: ({ window_minutes, critical }) =>
      `avg(last_${String(window_minutes)}m):p95:harness.approval.wait_ms{*} > ${String(critical)}`,
  },
  {
    id: "provider_error",
    name: "Harness provider error rate",
    type: "log alert",
    runbook: "docs/runbooks/provider-error.md#provider-error-and-fallback-rate",
    tags: ["service:harness", "signal:model"],
    description:
      "Counts failed runs marked model_error. The current safe-event contract does not expose fallback depth.",
    query: ({ window_minutes, critical }) =>
      `logs("@message:harness.safe.run_status @harness.run.status.to:failed @harness.run.status.reason:model_error").index("*").rollup("count").last("${String(window_minutes)}m") > ${String(critical)}`,
  },
  {
    id: "no_telemetry",
    name: "Harness safe telemetry missing",
    type: "log alert",
    runbook: "docs/runbooks/no-telemetry.md#no-safe-telemetry-received",
    tags: ["service:harness", "signal:availability"],
    description: "Alerts when no safe event logs arrive within the configured window.",
    query: ({ window_minutes, critical }) =>
      `logs("@message:harness.safe*").index("*").rollup("count").last("${String(window_minutes)}m") <= ${String(critical)}`,
  },
] as const satisfies readonly MonitorTemplate[];

/** Renders the checked Datadog monitor subset from the shared threshold contract. */
export function createDatadogMonitors(thresholds: AlertThresholds): DatadogMonitor[] {
  return monitorTemplates.map((template) => {
    const threshold = thresholds[template.id];
    return {
      id: template.id,
      name: template.name,
      type: template.type,
      query: template.query(threshold),
      message: `${template.description}\n\nRunbook: ${template.runbook}`,
      tags: [...template.tags],
      priority: threshold.priority,
      threshold_key: template.id,
      runbook: template.runbook,
      options: { thresholds: { critical: threshold.critical } },
    };
  });
}
