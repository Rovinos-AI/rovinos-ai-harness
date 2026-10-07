# Epic #10: OTel Collector (isolated gateway)

**Goal:** the only network path out of the harness for telemetry, with an attribute allowlist as the final backstop behind the in-process processors and the leak sentinel. Read `docs/engineering/CONVENTIONS.md` first, then epic 4.
**Tasks:** 10.1 to 10.6, all size S.

Shared design for this epic:
- **Defense in depth.** The harness process already sanitizes (epic 4) and gates (epic 8). The collector assumes the process may be buggy or compromised and enforces the same allowlist independently.
- **Config layering.** Collector configs are split into files merged with repeated `--config` flags: `base.yaml` (receivers, limiter, batch, health), `allowlist.generated.yaml` (generated), `profile-*.yaml` (exporters and pipelines per environment). No secrets in files; use `${env:NAME}` substitution.
- **Pin versions.** The collector image tag is pinned in `infra/collector/VERSION` (verify the current contrib release when implementing) and bumped deliberately.
- Files live under `infra/collector/`. Compose files under `infra/compose/`.

---

## 10.1 Base collector config with OTLP receiver, limiter, batch, and debug profile

**Parent:** #10 OTel Collector
**Task Description:** Create the layered base configuration and the compose service for the collector.
**Expected Inputs:** Pinned collector image version.
**Expected Output:** `infra/collector/base.yaml`, `infra/collector/profile-debug.yaml`, `infra/collector/VERSION`, `otel-collector` service in `infra/compose/docker-compose.yml` and `docker-compose.test.yml`, validation script `scripts/collector/validate.sh`.
**Dependencies:** Docker image `otel/opentelemetry-collector-contrib` at the pinned version (verify).
**Items it depends on:** 1.3, 1.8.
**Implementation guidance:**
1. `base.yaml`: receivers `otlp` (protocols `grpc` on `0.0.0.0:4317` and `http` on `0.0.0.0:4318`); processors `memory_limiter` (`check_interval: 1s`, `limit_mib: 256`, `spike_limit_mib: 64`) and `batch` (`timeout: 5s`, `send_batch_size: 512`); extensions `health_check` on `0.0.0.0:13133`; `service.telemetry.metrics.level: basic` with the collector's own metrics address bound to `0.0.0.0:8888` (internal network only).
2. `profile-debug.yaml`: exporter `debug` (`verbosity: basic`) and pipelines for traces, logs, metrics: `receivers: [otlp]`, `processors: [memory_limiter, batch]`, `exporters: [debug]`. The allowlist processors are added to the pipelines in 10.2 through a generated profile include; leave a comment marking where.
3. Compose service: image pinned from `VERSION` via build arg or `.env` file, command `["--config=/etc/otel/base.yaml","--config=/etc/otel/profile-debug.yaml"]`, config files mounted read-only, **no published ports** except in the dev profile (`4318:4318` on `127.0.0.1` only).
4. `scripts/collector/validate.sh <profile>` runs `docker run --rm -v ... <image> validate --config=... --config=...` for the requested profile and exits non-zero on error. Use it from the integration stage.
5. Container runs as the image's non-root user; mount configs read-only.
**Tests to write:** `scripts/collector/validate.int.test.ts` validates the base plus debug profile; a unit test parses the YAML and asserts no literal secrets (regex for `api_key`/`password` with non-`${env:` values) and that no `0.0.0.0` port is published in prod profiles.
**Acceptance Criteria:**
- [ ] `docker compose up` brings the collector to a healthy state (health endpoint returns 200).
- [ ] Config validation passes in CI.
- [ ] Image version pinned in one place.

---

## 10.2 Attribute allowlist generated from the registry

**Parent:** #10 OTel Collector
**Task Description:** Generate the collector's allowlist processors from the same registry the harness uses, so both sides always agree.
**Expected Inputs:** Span/log definitions (4.1, 4.3), metric allowlist, resource key allowlist.
**Expected Output:** `scripts/gen-collector-allowlist.ts`, `infra/collector/allowlist.generated.yaml`, `packages/telemetry/src/metrics.ts` `METRIC_ALLOWLIST` constant, `pnpm gen:collector --check`.
**Dependencies:** `yaml`.
**Items it depends on:** 4.6, 4.7, 10.1.
**Implementation guidance:**
1. Generated processors:
   - `filter/drop_unregistered_spans`: `error_mode: ignore`, `traces.span` condition dropping any span whose `name` is not one of the registered span names (`not (name == "a" or name == "b" ...)`).
   - `filter/drop_span_events`: `traces.spanevent: ['true']` (drops all span events including exceptions).
   - `transform/span_attributes`: for each span name a statement `keep_keys(span.attributes, [<allowed keys>]) where name == "<span name>"` and `set(span.status.message, "")` (verify OTTL function names and context paths against the pinned version).
   - `filter/drop_unregistered_logs`: drop log records whose `body` is not a registered log record name; `transform/log_attributes`: `keep_keys(log.attributes, [...]) where body == "<name>"`.
   - `transform/resource_attributes`: `keep_keys(resource.attributes, ["service.name","service.version","harness.policy.version","telemetry.sdk.name","telemetry.sdk.language","telemetry.sdk.version"])`.
   - `filter/drop_unregistered_metrics` and `transform/metric_attributes` from `METRIC_ALLOWLIST: Record<Code, Code[]>` (metric name to allowed datapoint attribute keys).
2. `METRIC_ALLOWLIST` lives in `packages/telemetry/src/metrics.ts`; add a unit test that every instrument created through the telemetry package is listed (wrap `meter.createCounter` in a helper that asserts allowlist membership).
3. Generator output is deterministic (sorted keys) and carries a header comment with the policy version (10.5).
4. `--check` regenerates in memory and fails on drift. Add to the `static` stage.
5. Include the generated file and a `pipelines` fragment in profiles via additional `--config` files so pipelines use `processors: [memory_limiter, filter/..., transform/..., batch]` in that order (limiter first, batch last).
**Tests to write:** snapshot test of generated YAML for a fixture registry; `--check` drift detection; metric allowlist membership test; YAML validates with the collector (`validate.sh`).
**Acceptance Criteria:**
- [ ] Allowlist regenerated from code, never hand-edited.
- [ ] CI fails when the registry and generated file diverge.
- [ ] Collector validates with the generated processors.

---

## 10.3 Datadog and Azure Data Explorer exporter profiles

**Parent:** #10 OTel Collector
**Task Description:** Add production exporter profiles and verify the needed components exist in the chosen collector distribution.
**Expected Inputs:** Pinned image, exporter settings via environment variables.
**Expected Output:** `infra/collector/profile-datadog.yaml`, `infra/collector/profile-adx.yaml`, `infra/collector/profile-test.yaml` (file exporter), `scripts/collector/verify-components.sh`, fallback `infra/collector/builder.yaml` (documented, not built by default).
**Dependencies:** collector-contrib components `datadog` and `azuredataexplorer` exporters, `file` exporter (verify names and option keys against the pinned version).
**Items it depends on:** 10.2.
**Implementation guidance:**
1. `verify-components.sh` runs the collector `components` subcommand (verify) and asserts the presence of exporters `datadog`, `azuredataexplorer`, `file`, `debug`, and processors `transform`, `filter`, `memory_limiter`, `batch`. If a required component is missing the script prints the `builder.yaml` fallback instructions and fails.
2. `profile-datadog.yaml`: exporter `datadog` with `api.key: ${env:DD_API_KEY}` and `api.site: ${env:DD_SITE}`; pipelines (traces, logs, metrics) use the allowlist processors from 10.2.
3. `profile-adx.yaml`: exporter `azuredataexplorer` with `cluster_uri: ${env:ADX_CLUSTER_URI}`, `db_name: ${env:ADX_DATABASE}`, authentication through managed identity (preferred) or `application_id/application_key/tenant_id` environment variables (verify option names), table names `HarnessTraces`, `HarnessLogs`, `HarnessMetrics`, `ingestion_type: managed` (verify).
4. `profile-test.yaml`: exporter `file` writing JSON lines to `/var/otel-out/{traces,logs,metrics}.jsonl` (used by 10.6), with the same allowlist processors.
5. No literal credentials anywhere; add the secret-scan unit test from 10.1 for the new files.
6. Document required environment variables and Azure role assignments in `docs/telemetry/collector.md`.
**Tests to write:** `verify-components.sh` runs in the integration stage; all profiles pass `validate.sh`; unit test confirms every exporter profile includes the allowlist processors in its pipelines (parse YAML and assert processor order); secret-literal scan.
**Acceptance Criteria:**
- [ ] Missing components fail CI with a clear fallback pointer.
- [ ] Every production profile includes the allowlist processors.
- [ ] No credentials in config files.

---

## 10.4 Compose and network policy: only the collector has egress

**Parent:** #10 OTel Collector
**Task Description:** Make network isolation structural and tested.
**Expected Inputs:** Compose networks and service definitions.
**Expected Output:** compose networks `internal` (`internal: true`) and `egress`, `harness` attached to `internal` only, collector attached to both, `infra/k8s/networkpolicy.example.yaml`, `test/network-isolation.int.test.ts`.
**Dependencies:** Docker, a tiny probe container (for example `busybox` or `node:22-slim`).
**Items it depends on:** 10.1, 1.8.
**Implementation guidance:**
1. In `docker-compose.yml`: `networks: { internal: { internal: true }, egress: {} }`. Services: `harness` -> `internal`; `otel-collector` -> `internal` and `egress`; `presidio-analyzer` (13.3) and other sidecars -> `internal` only.
2. `networkpolicy.example.yaml` for Kubernetes users: default-deny egress for the harness namespace, allow egress only to the collector service on 4317/4318 and to configured sidecars; document that this is an example.
3. Test fixture compose (`docker-compose.isolation.test.yml`) adds an `egress-probe` HTTP service attached only to `egress` and a `probe-client` container on `internal`. The test asserts: from `probe-client`, resolving or connecting to `egress-probe` fails and a request to a public name fails; from the collector (or a helper container attached to both networks) connecting to `egress-probe` succeeds.
4. Fail the test if any service other than the collector is attached to `egress` (parse `docker compose config --format json`).
5. Document that the collector's own egress targets are the exporter endpoints only.
**Tests to write:** `test/network-isolation.int.test.ts` (as described) plus a unit test over the rendered compose config asserting network membership.
**Acceptance Criteria:**
- [ ] The harness container cannot reach the egress network or the internet.
- [ ] Only the collector is on the egress network (asserted in CI).
- [ ] Kubernetes example provided and documented.

---

## 10.5 Health checks, versioned policy, and self-telemetry exposure

**Parent:** #10 OTel Collector
**Task Description:** Add readiness checks and a single `policyVersion` shared by the collector and the harness, recorded on every exported record.
**Expected Inputs:** Generated allowlist file.
**Expected Output:** `infra/collector/policy-version.generated.yaml` (resource processor), `packages/telemetry/src/generated/policy-version.ts`, health wiring in compose/tests, `docs/telemetry/policy-version.md`.
**Dependencies:** none.
**Items it depends on:** 10.2.
**Implementation guidance:**
1. `policyVersion = "p-" + first 12 hex chars of SHA-256(allowlist.generated.yaml contents)` (matches `Code`).
2. The generator (10.2) also emits `policy-version.generated.yaml` containing a `resource` processor with `attributes: [{ key: harness.policy.version, value: <version>, action: upsert }]`, placed last in the pipelines, and the TypeScript constant `POLICY_VERSION` used by `toSafeEvent` (7.10) and the SDK resource.
3. Drift check: `gen:collector --check` covers both generated files; a unit test asserts `POLICY_VERSION` equals the hash of the committed allowlist file.
4. Health: the contrib image has no shell, so Docker `HEALTHCHECK` is not possible inside it; instead add a lightweight `otel-health-wait` helper script used by compose `depends_on` ordering in tests (poll `http://otel-collector:13133/` from a probe container) and by `harness doctor` (a `collector_reachable` check hitting the health endpoint through the configured OTLP endpoint's host).
5. Collector self-metrics (port 8888) remain on the internal network; document how to scrape them.
**Tests to write:** policy version determinism and drift test; resource processor present last in every profile's pipelines; doctor check unit test with a mocked HTTP server; integration test waiting for health.
**Acceptance Criteria:**
- [ ] One policy version value is used everywhere and checked for drift.
- [ ] `harness doctor` reports collector health.
- [ ] Self-metrics are not reachable from outside the internal network.

---

## 10.6 Fixture test: forbidden attributes never reach the file exporter

**Parent:** #10 OTel Collector
**Task Description:** Prove with a real collector container that disallowed data never leaves it, with positive and negative controls.
**Expected Inputs:** `profile-test.yaml`, OTLP fixtures.
**Expected Output:** `test/collector-allowlist.int.test.ts`, fixture builders `test/fixtures/otlp.ts`.
**Dependencies:** `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http` (test only).
**Items it depends on:** 10.3, 10.5.
**Implementation guidance:**
1. Start the collector with `profile-test.yaml` and a shared volume for output; wait for health.
2. Send via OTLP/HTTP: (a) a **registered** span with legitimate attributes (positive control); (b) the same span with extra attributes: `http.url` containing `?token=<canary>`, `exception.message=<canary>`, an unknown attribute `custom.note=<canary>`; (c) an **unregistered** span name carrying a canary; (d) a span with an `exception` event and a status message containing canaries; (e) resource attributes `host.name`, `process.command_line` with canaries; (f) log records with free-text body and attributes; (g) a metric with an extra attribute and an unregistered metric.
3. Read the JSON-lines output files and assert: the legitimate data is present; **no canary substring** appears anywhere in any output file; unregistered spans, logs and metrics are absent; span events are absent; resource attributes are only the allowlisted keys; `harness.policy.version` is present on every record.
4. **Negative control:** run a second container with a profile that omits the allowlist processors and assert the canaries **do** appear (proves the test can detect leaks); the negative-control profile exists only under `test/` and is never referenced by production compose files.
5. Keep the test deterministic: fixed trace ids, wait for the file exporter flush with a bounded poll.
**Tests to write:** the integration test above (including both controls).
**Acceptance Criteria:**
- [ ] No canary appears in the real collector's output.
- [ ] The negative control fails to protect (shows leakage), proving test sensitivity.
- [ ] Test runs in the Azure `integration` stage.
