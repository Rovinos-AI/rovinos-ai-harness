# AGENTS.md: infra/collector

OpenTelemetry Collector configs: base, generated allowlist, profiles per backend.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [epic-10-otel-collector.md](./epic-10-otel-collector.md): tasks 10.1-10.6
<!-- END GENERATED: agents-index -->

## Boundaries
- Configuration only.

## Rules
- `allowlist.generated.yaml` and `policy-version.generated.yaml` are generated (`pnpm gen:collector`); CI fails on drift.
- Every production pipeline must include the allowlist processors in order: memory_limiter, filters, transforms, resource, batch.
- No literal credentials; env substitution only. The collector is the only service on the external network.
- Pin the collector image in `VERSION`; confirm required components with `scripts/collector/verify-components.sh`.

## Testing
- Run the real collector in the integration stage; keep both the positive and negative control in the fixture test.
