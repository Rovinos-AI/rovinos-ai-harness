# AGENTS.md: packages/host

MCP Apps host: sandboxed iframe reference host, app call routing, telemetry ingestion, limits.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [epic-03-host-bridge.md](./epic-03-host-bridge.md): tasks 3.1-3.7

## Allowed internal imports
- `@harness/schemas`, `@harness/telemetry`, `@harness/core`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).
<!-- END GENERATED: agents-index -->

## Boundaries
- `core` is imported by server-side code only. `src/web/` is browser code: no secrets, no Node APIs.

## Rules
- Apps are untrusted code. Iframe: `sandbox="allow-scripts"` only (never `allow-same-origin`), deny-all CSP, no network.
- App telemetry enters only through `harness.telemetry.emit`: validated, size-limited, rate-limited, and stamped by the host (identity and time come from the host).
- Apps may call only tools in `apps[].allowedTools`, subject to policy.
- The host listens on loopback with a per-process token; check `Origin`.

## Testing
- Playwright tests with hostile fixtures (`test/fixtures/hostile-app`); install Chromium in CI.
