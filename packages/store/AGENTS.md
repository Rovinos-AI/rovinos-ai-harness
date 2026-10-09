# AGENTS.md: packages/store

EventStore interface and adapters (in-memory, SQLite, Postgres), conformance suites, snapshots, outbox, migrations, retention.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-07-event-store.md](./epic-07-event-store.md): tasks 7.1-7.15

## Allowed internal imports

- `@harness/schemas`, `@harness/telemetry`, `@harness/crypto`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Rules

- The store assigns `seq`; callers pass `expectedSeq`. A mismatch throws `SeqConflictError` and writes nothing. Never add a retry loop around it.
- Appends are all-or-nothing. Content is encoded through the `ContentCodec`; meta and content are stored separately.
- Schema changes go through migrations only (task 7.12). No inline `CREATE TABLE` after that.
- Every new adapter must pass `runEventStoreConformance` and `runConcurrencyConformance`.
- Parameterized SQL only; never interpolate values.

## Testing

- Conformance suites for each adapter; Postgres tests are `*.int.test.ts` using the compose service.
