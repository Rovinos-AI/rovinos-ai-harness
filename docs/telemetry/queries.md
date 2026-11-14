# Kusto query starter set

The queries in `infra/kusto/queries/` read the `HarnessLogs` columns documented
in [the Kusto schema](kusto.md). Each query has a `lookback` timespan near the
top; adjust it before running the query. Event kinds are selected from the
exporter's `Body` value (`harness.safe.<kind>`), and each query keeps its
`LogsAttributes` extraction in one helper so changes to the log mapping have a
single update point.

| Query | Purpose | Intended dashboard or alert |
| --- | --- | --- |
| `run_success_rate` | Counts completed, failed, and cancelled terminal transitions and reports the overall completion fraction. | Runs overview panel; candidate terminal-failure monitor. |
| `model_latency_percentiles` | Reports model-call latency p50, p95, and p99 by provider and model. | Model latency dashboard panel. |
| `cost_and_repair_rate` | Totals input/output tokens and repair attempts and reports schema-valid rate by provider and model. The SafeEvent log does not include priced cost, so this query does not estimate currency spend. | Model usage and quality dashboard panel. |
| `tool_timeouts` | Counts timed-out tool calls by tool id. | Tool reliability dashboard panel. |
| `approval_wait` | Reports approval wait p50, p95, and p99 by decision and decision source. | Approval wait dashboard panel and wait alert. |
| `pii_actions` | Counts PII-action records and their aggregate entity counts by boundary and action. | Safety dashboard panel. |
| `resume_counts` | Counts run-status records whose reason is `resumed`, grouped by resulting status. | Run lifecycle dashboard panel. |
| `sentinel_trips` | Counts PII-action records at the `telemetry_export` boundary by action. | Leak-sentinel alert. |

These are Kusto query assets for operator use; the existing Datadog dashboard
queries its metric allowlist and does not execute KQL. Dashboard panels and
alerts in the table are intended consumers; wiring them to these KQL assets is
a separate integration step.

## Exported-data limits

The current SafeEvent log mapping exports PII entity counts as the scalar
`harness.pii.entity_count`; it does not export the entity array or its types.
Accordingly, `pii_actions` aggregates counts without `mv-expand` or an
entity-type breakdown. Preserving entity types would require a separately
reviewed telemetry mapping change and is outside this query-only task.

## Validation and fixture updates

The committed rows in `test/fixtures/kusto/safe-events.jsonl` are generated
through `emitSafeEvent` and the in-process log allowlist. Regenerate them with
`yarn gen:kusto-fixtures`; use `yarn gen:kusto-fixtures --check` to verify
determinism and drift. `test/kusto-queries.int.test.ts` applies the schema,
ingests those rows, runs all eight queries in the Kusto emulator, and compares
the results with `test/fixtures/kusto/query-results.json`.

The current task maps the retired Azure pipeline's `integration` stage to the
GitHub Actions `integration` job, as specified in the task notes.
