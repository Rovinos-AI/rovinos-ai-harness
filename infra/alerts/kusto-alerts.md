# Kusto alerts and Azure Monitor suggestions

<!-- cspell:ignore tolong countif startswith -->

Datadog query syntax in `datadog-monitors.json` is a repository subset and has not been verified against a live Datadog account. Verify it and configure the account's notification routes before applying monitors. Thresholds, including each lookback window and critical value, are owned by [`thresholds.yaml`](./thresholds.yaml); scheduled query rules should use those values rather than maintaining a second set of defaults.

The queries below use `HarnessLogs` and `HarnessMetrics` columns from the Kusto schema. Bind `lookback` to the corresponding `window_minutes` in `thresholds.yaml` when configuring each scheduled query rule. They intentionally aggregate across runs and do not group on IDs or other high-cardinality fields.

## Leak sentinel

Suggested Azure Monitor rule: page when the query's `sentinel_trips` result is greater than the `leak_sentinel.critical` threshold. Preserve relevant audit evidence before following the [leak-sentinel runbook](../../docs/runbooks/leak-sentinel.md#suspected-telemetry-leak).

```kusto
declare query_parameters (lookback:timespan);
HarnessLogs
| where Timestamp >= ago(lookback)
| where Body == "harness.safe.pii_action"
| where tostring(LogsAttributes["harness.pii.boundary"]) == "telemetry_export"
| where tostring(LogsAttributes["harness.pii.action"]) == "blocked"
| summarize sentinel_trips = count()
```

## Rejected application spans and detector degradation

Suggested Azure Monitor rules: sum `MetricValue` by metric name within the `rejected_app_spans` and `pii_detector_degraded` windows, then compare with the matching critical threshold.

```kusto
declare query_parameters (lookback:timespan);
HarnessMetrics
| where Timestamp >= ago(lookback)
| where MetricName in ("harness.host.app_rejected", "harness.pii.detector_degraded")
| summarize observed = sum(MetricValue) by MetricName
```

## Budget-exceeded runs

Suggested Azure Monitor rule: count events by the bounded budget kind and compare the total with `budget_exceeded.critical`.

```kusto
declare query_parameters (lookback:timespan);
HarnessLogs
| where Timestamp >= ago(lookback)
| where Body == "harness.safe.budget_exceeded"
| summarize budget_exceeded = count() by budget_kind = tostring(LogsAttributes["harness.budget.kind"])
```

## Approval waits and expiries

Suggested Azure Monitor rules: compare the p95 `wait_ms` result with `approval_wait.critical`; separately count completed `expiry` decisions. The safe event records completed expiry decisions, not a prediction that an outstanding approval is close to expiry. See the [approval-wait runbook](../../docs/runbooks/approval-wait.md#approval-wait).

```kusto
declare query_parameters (lookback:timespan);
HarnessLogs
| where Timestamp >= ago(lookback)
| where Body == "harness.safe.approval_wait"
| extend wait_ms = tolong(LogsAttributes["harness.approval.wait_ms"]),
         decided_by = tostring(LogsAttributes["harness.approval.decided_by"])
| summarize wait_p95_ms = percentile(wait_ms, 95),
            expiry_decisions = countif(decided_by == "expiry")
```

## Provider errors and fallback

The `provider_error` monitor counts failed run-status events with reason `model_error`, and is only a provider-error proxy. The current safe model-call event does not export fallback depth, so a fallback-rate alert is not represented here. Do not infer fallback rate from unrelated model metrics; add a reviewed bounded signal before defining that alert. See the [provider-error runbook](../../docs/runbooks/provider-error.md#provider-error-and-fallback-rate).

```kusto
declare query_parameters (lookback:timespan);
HarnessLogs
| where Timestamp >= ago(lookback)
| where Body == "harness.safe.run_status"
| where tostring(LogsAttributes["harness.run.status.to"]) == "failed"
| where tostring(LogsAttributes["harness.run.status.reason"]) == "model_error"
| summarize provider_error_runs = count()
```

## No safe telemetry

Suggested Azure Monitor rule: alert when `safe_event_count` is zero in the `no_telemetry.window_minutes` interval. Confirm expected workload activity before treating an idle period as a pipeline outage.

```kusto
declare query_parameters (lookback:timespan);
HarnessLogs
| where Timestamp >= ago(lookback)
| where Body startswith "harness.safe."
| summarize safe_event_count = count()
```

The existing public SDK/CLI metrics-export integration test checks the dashboard's `harness.model.tokens` metric in a receiving OTLP sink, alongside a synthetic content canary. Its negative controls also reject high-cardinality run, session, user, trace, and span labels.
