# AGENTS.md: packages/app-telemetry

Tiny browser-safe telemetry shim used inside MCP Apps. Part of epic 5 (tasks 5.1 and 5.2).

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [TASKS.md](./TASKS.md) (specs in other folders): tasks 5.1, 5.2

## Allowed internal imports

- None (leaf package).
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Boundaries

- No runtime dependencies. Browser-safe only.

## Rules

- Never call `fetch`, `XMLHttpRequest`, `WebSocket`, or `sendBeacon` (a test scans the bundle).
- Bundle must stay under 4 KB gzip (test enforces it).
- Methods never throw into app code; the shim is a silent no-op without a host.
- Only manifest-declared span names with typed attributes.

## Testing

- Type-level tests with `expectTypeOf`; bundle-size and forbidden-identifier tests.
