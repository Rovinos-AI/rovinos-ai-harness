# Collector network access

Docker Compose attaches the harness and collector to the internal network. Only the collector also joins the egress network; the harness and sidecars cannot route directly outside the internal network. The collector's own egress is reserved for the exporter endpoints enabled by its profile, not general-purpose traffic.

`infra/k8s/networkpolicy.example.yaml` is an example Kubernetes policy, not a supported deployment. It denies egress by default in the namespace, permits DNS to kube-dns, and permits harness pods to reach the collector on OTLP ports 4317 and 4318 and pods explicitly labeled as approved harness sidecars. The sidecar rule has no known port in this example: operators must add its specific `ports` list before applying it because an omitted port list permits all ports. Adapt selectors to the deployment and ensure no other NetworkPolicy grants the harness additional egress. The default-deny policy also blocks collector exporter traffic. The commented collector policy is a template: replace its CIDR with operator-approved exporter destinations and adapt the pod label before enabling it. Standard Kubernetes NetworkPolicy does not express DNS names.

## Exporter profiles

The collector image is pinned in `infra/collector/VERSION`. Select one profile with
the base and generated allowlist configs; only Datadog and ADX profiles send
telemetry to external services.

### Datadog

The `datadog` profile requires `DD_API_KEY` and `DD_SITE` in the collector
environment. Supply the API key through the deployment's secret mechanism; do
not place it in a config file or commit it. `DD_SITE` is the Datadog site for
the account, such as `datadoghq.com`.

### Azure Data Explorer

The `adx` profile requires `ADX_CLUSTER_URI`, `ADX_DATABASE`, and
`ADX_MANAGED_IDENTITY_ID`. Use `system` for a system-assigned managed identity,
or the client ID for a user-assigned managed identity. Grant that identity the
Azure Data Explorer **Database Ingestor** role on the target database, and
pre-create the `HarnessTraces`, `HarnessLogs`, and `HarnessMetrics` tables.
The profile uses managed ingestion; enable streaming ingestion for those tables
on the cluster. The fallback service-principal options are intentionally not
configured, so no application key or tenant credential is needed.

### File test exporter

The `test` profile writes newline-delimited JSON to
`/var/otel-out/{traces,logs,metrics}.jsonl`. The directory must be writable by
the collector and should be supplied by the test environment; this profile is
for local and integration testing, not production export.

The pinned contrib image includes every required component. If
`scripts/collector/verify-components.sh` reports one missing, use
`infra/collector/builder.yaml` as a manual OpenTelemetry Collector Builder
fallback; it is not built by default. Pin the resulting custom image in
`infra/collector/VERSION` before validating or deploying it.
