# Telemetry policy version

The collector and harness use the same policy version for exported telemetry. The value is
`p-` followed by the first 12 lowercase hexadecimal characters of the SHA-256 digest of the exact
contents of `infra/collector/allowlist.generated.yaml`. `yarn gen:collector` writes the value to
`infra/collector/policy-version.generated.yaml` and
`packages/telemetry/src/generated/policy-version.ts`; `yarn gen:collector --check` detects drift.

The collector writes `harness.policy.version` as a resource attribute with the upsert action after
the allowlist transforms. The telemetry SDK attaches the generated `POLICY_VERSION` to its
resource, and safe event projections use that same value.

The collector health endpoint listens on port `13133` on the internal network. In Compose, the
harness advertises its OTLP endpoint as `http://otel-collector:4318`; `harness doctor` checks the
health endpoint on that host. `collector_reachable` warns when no OTLP endpoint is configured and
fails when a configured collector does not return a successful health response.

Collector self-metrics listen on port `8888` and are not published to the host. A Prometheus scraper
can scrape `http://otel-collector:8888/metrics` when attached to the Compose internal network; do
not attach that scraper to the collector's external network.
