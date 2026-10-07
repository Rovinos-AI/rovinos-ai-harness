# AGENTS.md: infra

Deployment and observability assets: compose, collector, dashboards, Kusto, alerts, Kubernetes examples.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [epic-11-backends.md](./epic-11-backends.md): tasks 11.1-11.6
- [alerts/TASKS.md](./alerts/TASKS.md) (specs in other folders): tasks 11.5
- [dashboards/TASKS.md](./dashboards/TASKS.md) (specs in other folders): tasks 11.3
- [k8s/TASKS.md](./k8s/TASKS.md) (specs in other folders): tasks 10.4
<!-- END GENERATED: agents-index -->

## Also touched by
- 19.8 ([epic-19](../packages/sandbox/epic-19-sandbox-and-container-execution.md)) compose profiles. Collector tasks 10.x are owned by `infra/collector/`.

## Boundaries
- Configuration only; no application code.

## Rules
- No secrets in any file; use `${env:NAME}`, Docker secrets, or Key Vault references.
- Pin image versions (digest where possible).
- Generated files are never hand-edited; regenerate with the documented script and commit the result.
- Every external-facing name marked "(verify)" in the specs must be checked against the pinned version.

### `k8s/`: Example Kubernetes manifests (not a supported deployment)
- Keep default-deny egress; allow only collector and configured sidecars.
- Label every file as an example.

### `alerts/`: Alert definitions and runbooks
- All thresholds live in `thresholds.yaml`; monitor JSON is generated from the template (`--check` in CI).
- Every alert links to a runbook anchor in `docs/runbooks/`.
- The leak-sentinel alert pages on any nonzero count.

### `dashboards/`: Datadog dashboards as code
- Queries may reference only metrics present in `METRIC_ALLOWLIST` (validator enforces).
- Mark any query syntax unverified until checked in a real account.
- Applying a dashboard to an account is manual and credential-gated; never from CI.
