# Epic #11: Backends (sinks, dashboards, alerts)

**Goal:** make metadata-only telemetry genuinely useful: validated sink policies, a Kusto (Azure Data Explorer) schema and queries, a Datadog dashboard, alerts with runbooks, and a guard against high-cardinality metrics. Read `docs/engineering/CONVENTIONS.md` first, plus epics 4 and 10.
**Tasks:** 11.1 to 11.6, all size S.

Shared design for this epic:
- **Metadata only.** Backends receive allowlisted spans, `SafeEvent` log records, and bounded metrics. Debugging content requires replaying from the event store (epic 9), never searching a backend.
- **Verify against real schemas.** Exporter table schemas, Datadog query syntax, and emulator behavior change; every external-facing name in this epic is marked "(verify)" and covered by contract tests so drift is detected.
- Assets live in `infra/kusto/`, `infra/dashboards/datadog/`, `infra/alerts/`, and `docs/telemetry/`. Applying assets to real accounts is a manual, documented step; CI validates structure and, for Kusto, runs against an emulator.

---

## 11.1 Per-sink policy schema and startup validation

**Parent:** #11 Backends
**Task Description:** Declare each telemetry sink with a maximum data classification and verify at startup that the pipeline actually enforces it.
**Expected Inputs:** `telemetry.sinks` config, collector profile files.
**Expected Output:** `packages/schemas/src/config/telemetry.ts` (`SinkPolicy`), `packages/telemetry/src/sinks/policy.ts` (`assertSinkPolicies`), startup integration, docs `docs/telemetry/sinks.md`.
**Dependencies:** `yaml`.
**Items it depends on:** 10.3, 10.5, 20.1.
**Implementation guidance:**
1. `SinkPolicy = { id: Code, kind: "datadog" | "kusto" | "stdout" | "file", maxClassification: "metadata" | "content_tokenized" (default "metadata"), enabled: boolean (default true) }`. `content_tokenized` is **rejected** unless `telemetry.unsafe.allowContentSinks: true`, in which case startup logs `telemetry_content_sink_enabled` and the sink must additionally point at an access-controlled destination documented in the config comment.
2. `assertSinkPolicies(config, { collectorConfigDir })` runs at startup and in `harness doctor`: for each enabled sink load the matching collector profile (`profile-datadog.yaml`, `profile-adx.yaml`, `profile-test.yaml`, `profile-debug.yaml`), parse pipelines, and verify every pipeline listing that sink's exporter includes the generated allowlist processors in order (limiter, filters, transforms, resource, batch). Missing processors throw `sink_policy_violation` naming the sink id.
3. Verify that the `policyVersion` in the generated collector files equals `POLICY_VERSION` compiled into the harness (10.5); mismatch is `sink_policy_version_mismatch`.
4. Sinks of kind `stdout`/`file` (local debugging) obey the same rules.
5. Register a `sink_policies` doctor check (20.4).
**Tests to write:** valid config passes; each violation (missing processor, wrong order, unknown profile, version mismatch) fails with its code; `content_tokenized` rejected by default and accepted only with the unsafe flag; doctor check output.
**Acceptance Criteria:**
- [ ] A sink without the allowlist pipeline cannot start.
- [ ] Content-capable sinks require an explicit unsafe opt-in.
- [ ] Policy and collector versions are checked for drift.

---

## 11.2 Kusto schema, ingestion mapping, and emulator contract test

**Parent:** #11 Backends
**Task Description:** Define the Azure Data Explorer tables and verify them against an emulator.
**Expected Inputs:** Exporter output column layout, emulator image.
**Expected Output:** `infra/kusto/schema.kql`, `scripts/kusto/apply-schema.ts`, `kusto-emulator` service in `docker-compose.test.yml`, `test/kusto-schema.int.test.ts`, docs `docs/telemetry/kusto.md`.
**Dependencies:** `azure-kusto-data` (client), Kusto emulator container image `mcr.microsoft.com/azuredataexplorer/kustainer-linux` (verify tag and EULA environment variable).
**Items it depends on:** 10.3, 1.8.
**Implementation guidance:**
1. First confirm the table and column names the `azuredataexplorer` exporter creates or expects (verify in the pinned collector's exporter documentation); record them in the docs. `schema.kql` uses `.create-merge table` for `HarnessTraces`, `HarnessLogs`, `HarnessMetrics` with the exporter's columns (for logs: timestamps, trace and span ids, severity, body, `ResourceAttributes: dynamic`, `LogsAttributes: dynamic`), corresponding JSON ingestion mappings, and retention (`.alter-merge table ... policy retention softdelete = 30d` configurable).
2. `apply-schema.ts` reads the `.kql` file, splits commands by blank line, and executes them with the Kusto client against `ADX_CLUSTER_URI` (or the emulator URL); idempotent by design (`create-merge`).
3. Compose service `kusto-emulator` (`ACCEPT_EULA=Y`, port 8080 internal only); the integration test waits for readiness, applies the schema, and then ingests fixture rows with inline ingestion (`.ingest inline into table ... <| ...`; the emulator may not support queued ingestion, a documented limitation) and runs a count query.
4. Document that the end-to-end exporter path to a real cluster is verified manually or by the `LIVE` nightly test (optional task note: add when a test cluster exists).
5. Use a unique database per test run (`h_<ulid>`), dropped in cleanup.
**Tests to write:** schema applies twice (idempotent); fixture ingestion and query; schema file lint (every table has a retention policy and mapping); apply script unit tests with a fake client (command splitting, error propagation).
**Acceptance Criteria:**
- [ ] Schema applies cleanly to the emulator in CI.
- [ ] Exporter column names are documented with their verification source.
- [ ] Each table has a retention policy.

---

## 11.3 Datadog dashboard and supporting metrics

**Parent:** #11 Backends
**Task Description:** Add the metrics a Datadog dashboard needs and ship a starter dashboard as code.
**Expected Inputs:** `METRIC_ALLOWLIST` (10.2), run loop and gateway code.
**Expected Output:** metrics `harness.run.completed{outcome}`, `harness.model.latency_ms{provider,model}`, `harness.approval.wait_ms{decision}`, `harness.tool.calls{outcome}` registered in `METRIC_ALLOWLIST`; `infra/dashboards/datadog/harness-overview.json`; `scripts/datadog/validate-dashboard.ts`; optional `scripts/datadog/apply-dashboard.ts`.
**Dependencies:** Datadog API (apply script only, manual).
**Items it depends on:** 11.1, 10.2, 14.14, 17.7.
**Implementation guidance:**
1. Instrument: `harness.run.completed` counter (attribute `outcome` enum `completed|failed|cancelled`) at terminal transitions; `harness.model.latency_ms` histogram (attributes `provider`, `model`, both config-bounded Codes); `harness.approval.wait_ms` histogram (`decision` enum); `harness.tool.calls` counter (`outcome` enum). Existing metrics used: `harness.model.tokens`, `harness.model.cost_micros`, `harness.policy.decisions`, `harness.telemetry.dropped`, `harness.host.app_rejected`, `harness.pii.detector_degraded`.
2. Update `METRIC_ALLOWLIST` and regenerate the collector allowlist (10.2). Declare boundedness for each attribute (used by 11.6).
3. Dashboard JSON (Datadog dashboard format, verify): groups for Runs (completion rate by outcome), Models (latency p50/p95 by model, tokens, cost), Safety (leak-sentinel drops must be `0` highlighted; detector degraded; rejected app spans by reason), Approvals (wait p95, decisions), Tools (calls by outcome). Queries reference only the metrics above; mark query syntax **(verify against your Datadog account)**.
4. `validate-dashboard.ts` checks structure: JSON parses, widget types are from an allowed list, every query metric name appears in `METRIC_ALLOWLIST` (so dashboards cannot reference non-existent or disallowed metrics), group titles unique.
5. `apply-dashboard.ts` (manual, requires `DD_API_KEY` and `DD_APP_KEY` from the environment) creates or updates the dashboard by title; never run in CI by default.
**Tests to write:** metric emission tests (counters/histograms with bounded attributes); dashboard validator passes the committed dashboard and fails fixtures (unknown metric, bad widget type); allowlist regeneration drift check.
**Acceptance Criteria:**
- [ ] The dashboard only references allowlisted metrics (CI-enforced).
- [ ] New metrics have bounded, declared attributes.
- [ ] Apply script is manual and credential-gated.

---

## 11.4 Starter Kusto queries with contract tests

**Parent:** #11 Backends
**Task Description:** Provide the core analysis queries and prove them against fixture data.
**Expected Inputs:** Kusto schema (11.2), `SafeEvent` log fixtures.
**Expected Output:** `infra/kusto/queries/*.kql`, `test/fixtures/kusto/*.jsonl` (fixture rows), `test/kusto-queries.int.test.ts` with golden results, `docs/telemetry/queries.md`.
**Dependencies:** none beyond 11.2.
**Items it depends on:** 11.2, 4.3, 7.10.
**Implementation guidance:**
1. Queries (each a parameterized `let` header with a `lookback` timespan): `run_success_rate` (from `harness.safe.run_status` records where `to` is terminal, grouped by outcome); `model_latency_percentiles` (from `harness.safe.model_call`, `percentiles(latencyMs, 50, 95, 99)` by provider and model); `cost_and_repair_rate` (sum of tokens, repair attempts per call, schema-valid rate); `tool_timeouts` (from `harness.safe.tool_call` where outcome is timeout, by tool id); `approval_wait` (from `harness.safe.approval_wait`, percentiles by decision and `decidedBy`); `pii_actions` (from `harness.safe.pii_action`, count by boundary, action and entity type, using `mv-expand` on the entities array representation chosen in the log attribute mapping); `resume_counts` (run_status records with reason `resumed`); `sentinel_trips` (pii_action with boundary `telemetry_export`).
2. Use dynamic column extraction consistent with the exporter schema (for example `tostring(LogsAttributes["harness.event.kind"])`); centralize column access in a `let` function at the top of each file so schema drift needs one change per file (verify against 11.2 documentation).
3. Fixture rows are produced by a small script that runs real `SafeEvent`s through `emitSafeEvent` and the allowlist processors into the in-memory exporter and converts to the table row shape; commit the generated JSON Lines and a regeneration script (`pnpm gen:kusto-fixtures`).
4. Contract test: ingest fixtures into the emulator and run each query, comparing results to committed golden JSON; any schema or mapping change must update goldens deliberately.
5. Document each query with its purpose and the dashboard or alert that uses it.
**Tests to write:** the contract test (all queries); fixture generator determinism (hash stable); a lint that every `.kql` file starts with the standard header and contains no free-text attribute reads (only attributes present in the catalog from 4.7).
**Acceptance Criteria:**
- [ ] Every query returns the expected aggregates on fixture data in CI.
- [ ] Queries read only cataloged attributes.
- [ ] Fixtures regenerate deterministically.

---

## 11.5 Alerts and runbooks

**Parent:** #11 Backends
**Task Description:** Define actionable alerts as code, each with a runbook.
**Expected Inputs:** Metrics and queries from 11.3 and 11.4.
**Expected Output:** `infra/alerts/datadog-monitors.json`, `infra/alerts/thresholds.yaml`, `infra/alerts/kusto-alerts.md` (queries and suggested Azure Monitor rules), `docs/runbooks/*.md`, `scripts/alerts/validate.ts`.
**Dependencies:** none.
**Items it depends on:** 11.3, 11.4.
**Implementation guidance:**
1. Alerts: (a) **leak sentinel trips > 0** over 5 minutes (page); (b) rejected app spans rate above threshold; (c) PII detector degraded count above threshold; (d) budget-exceeded run rate; (e) approval wait p95 above threshold or approvals close to expiry; (f) provider error and fallback rate; (g) **no telemetry received** for 15 minutes (collector or pipeline down).
2. `thresholds.yaml` holds all numbers (documented defaults) so operators tune values without editing JSON; the monitor JSON is generated from a template and thresholds by `scripts/alerts/generate.ts` (committed output plus `--check` for drift).
3. Each alert has a `runbook` field linking to `docs/runbooks/<alert>.md#...`. Runbooks contain: what the alert means, immediate steps, how to identify the affected run (via the control plane or CLI using metadata: run id from the safe events), how to inspect safely (`harness inspect`, `harness replay`), containment actions (revoke tokens, stop the service, rotate keys via 12.5), and escalation. The sentinel runbook explicitly covers suspected leaks (preserve evidence, purge the affected exporter data at the backend, rotate credentials).
4. `validate.ts` checks: JSON structure, every alert has a runbook file and anchor, thresholds present for every alert, metric names exist in `METRIC_ALLOWLIST`, no runbook contains placeholder `TODO`.
**Tests to write:** validator passes committed files and fails fixtures; generator determinism and `--check`; runbook link checker.
**Acceptance Criteria:**
- [ ] Every alert has a runbook and a threshold in one tunable file.
- [ ] The sentinel alert pages on any nonzero count.
- [ ] Generated monitor JSON is drift-checked in CI.

---

## 11.6 High-cardinality guard

**Parent:** #11 Backends
**Task Description:** Prevent metric label explosions both statically and at runtime.
**Expected Inputs:** Metric registry, metric recording paths.
**Expected Output:** boundedness metadata in `METRIC_ALLOWLIST`, `packages/telemetry/src/cardinality.ts` (`CardinalityGuard`), counter reason `cardinality` added to `harness.telemetry.dropped`, static test.
**Dependencies:** none.
**Items it depends on:** 11.3, 4.2.
**Implementation guidance:**
1. Extend `METRIC_ALLOWLIST` entries to `{ attrs: Record<Code, { kind: "enum", values: Code[] } | { kind: "config", source: Code }> }` where `config` means the value set is bounded by configuration (for example model names from `models.providers`).
2. Static test: for every metric, fail if an attribute key matches `/(^|\.)(id|run|session|user|trace|span|path|url)($|\.)/` (case-insensitive) or lacks a declared bound; fail if an `enum` attribute declares more than 50 values.
3. `CardinalityGuard.admit(metric, attrs): boolean`: keeps a per-metric set of attribute-combination keys; once a metric has `maxSeries` (default 100) distinct combinations, new combinations are rejected, counted via `harness.telemetry.dropped{reason="cardinality"}` (add the enum value, regenerate collector allowlist) and logged once per metric with the sanctioned logger (`metric_cardinality_exceeded`, metric name as Code).
4. All metric recording goes through a helper that applies the guard (wrap instrument creation so direct instruments are impossible outside the helper; add to the lint from 4.5 if needed).
5. Config `telemetry.metrics.maxSeries` overrides the default.
**Tests to write:** guard admits up to the limit then drops and counts; per-metric isolation; static test failing on an unbounded attribute fixture and passing on the real registry; helper-only instrument creation lint; config override.
**Acceptance Criteria:**
- [ ] No metric can add an unbounded label without CI failing.
- [ ] Runtime series growth is capped per metric.
- [ ] Drops are visible via a bounded counter.
