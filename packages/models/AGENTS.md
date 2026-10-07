# AGENTS.md: packages/models

Model gateway: provider adapters, structured-output enforcement ladder, repair loop, retries, routing, cost accounting, cassettes.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [epic-14-model-gateway.md](./epic-14-model-gateway.md): tasks 14.1-14.15

## Allowed internal imports
- `@harness/schemas`, `@harness/telemetry`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).
<!-- END GENERATED: agents-index -->

## Boundaries
- Contains no PII logic; the PII layer wraps the gateway.

## Rules
- Adapters translate wire formats only: no retries, no repair, no schema enforcement.
- Requests must stay JSON-serializable (cassettes and replay depend on it).
- Provider-specific blobs (reasoning blocks, ids) must round-trip byte-for-byte; see task 14.11.
- No hardcoded prices or capabilities as truth; config overrides defaults.
- SDK-internal retries are disabled (`maxRetries: 0`).

## Testing
- `runProviderContract` for every adapter; `LIVE`-tagged tests are skipped without keys.
