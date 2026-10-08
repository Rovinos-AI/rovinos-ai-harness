# AGENTS.md: packages/telemetry

Closed span/log registry, allowlist processors, safe-event projection, leak sentinel, and the sanctioned logger.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [epic-04-span-allowlist.md](./epic-04-span-allowlist.md): tasks 4.1-4.7
- [epic-08-leak-sentinel.md](./epic-08-leak-sentinel.md): tasks 8.1-8.6

## Allowed internal imports
- `@harness/schemas`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).
<!-- END GENERATED: agents-index -->

## Also touched by
- 20.5 ([epic-20](../config/epic-20-config-and-cli-core.md)).

## Boundaries
- `@opentelemetry/sdk-*` and `pino` are imported only here.

## Rules
- Spans and log records are created only through `defineSpan`/`defineLogRecord`. Never call `tracer.startSpan`, `recordException`, or `console.*` (lint enforces this).
- Attributes must be built with `attr.*` helpers (Id, Code, enum, int, bool). No free-text strings, ever.
- The leak sentinel fails closed: error, timeout, or hit means drop the payload.
- Adding a span, attribute, or metric requires: `yarn docs:catalog`, `yarn gen:collector`, and an update to the canary scenarios if it opens a new path.
- The logger takes an event Code plus typed fields; there is no message parameter by design.

## Testing
- Leak fixture and property tests (`fast-check`); sentinel oracle tests against naive `includes`; never assert on content, only on absence of canaries.

## Gotchas
- Processors build a sanitized copy and drop; they never mutate in place and never throw into the OTel SDK (an exception means drop and count `processor_error`).
- The leak sentinel is a gate, not a cleaner: on hit, error, or timeout drop the whole payload. Never forward partially sanitized data.
- Sentinel matching is linear-time and regex-free; `RunValueSet` prints counts only (`toJSON`/`inspect` overridden).
- No default auto-instrumentations; HTTP/undici spans would carry URLs. Unregistered spans are dropped wholesale.
