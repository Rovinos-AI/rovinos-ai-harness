# AGENTS.md: infra/compose

Docker Compose files: base, dev, test, prod-like, isolation fixtures.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [TASKS.md](./TASKS.md) (specs in other folders): tasks 1.3, 1.8, 7.6, 10.1, 10.4, 13.3, 19.3, 19.4, 19.8, 12.9, 24.6
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
