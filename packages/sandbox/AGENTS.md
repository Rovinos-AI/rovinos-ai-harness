# AGENTS.md: packages/sandbox

Tool execution backends, runner service, egress proxy, workspace, snapshots.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [epic-19-sandbox-and-container-execution.md](./epic-19-sandbox-and-container-execution.md): tasks 19.1-19.8

## Allowed internal imports
- `@harness/schemas`, `@harness/telemetry`, `@harness/crypto`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).
<!-- END GENERATED: agents-index -->

## Rules
- Never mount or reference `docker.sock`. Never use shell strings: argv arrays only.
- Default deny: no network, read-only root filesystem, dropped capabilities, resource limits on every exec.
- One run per runner instance (lease). Do not weaken this without an ADR.
- All workspace paths go through `resolveWorkspacePath`; tar extraction uses the safe filter.
- Tests cite threat ids with `// threat: T-xx`; CI checks coverage.

## Testing
- Integration tests against the compose runner; hardening tests for images.

## Gotchas
- The sandbox is a separate `sandbox-runner` container on an internal network, not something the harness spawns. Anything that needs `docker.sock` is the wrong design.
- The child environment never inherits the parent env, including in the in-process dev backend (which refuses to run in production unless explicitly allowed).
- Egress logs carry counters and reason codes only, never hostnames or URLs.
- Tar restore must use the safe-extraction filter; malicious archives must not write outside the target.
