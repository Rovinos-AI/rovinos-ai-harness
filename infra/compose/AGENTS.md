# AGENTS.md: infra/compose

Docker Compose files: base, dev, test, prod-like, isolation fixtures.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

<!-- END GENERATED: agents-index -->

## Boundaries

- Configuration only.

## Rules

- No `privileged`, no `docker.sock`, no `network_mode: host`. Every service: `cap_drop: [ALL]`, `no-new-privileges`, read-only rootfs with explicit tmpfs.
- Only the collector (and the sandbox egress proxy when enabled) may attach to external networks.
- Prod-like sets CPU/memory limits and `stop_grace_period` greater than `run.shutdownGraceMs`.
- `scripts/compose/validate.ts` must pass for every profile.

## Testing

- Validator unit tests with bad-config fixtures; network isolation integration test.
