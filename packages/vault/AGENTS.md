# AGENTS.md: packages/vault

Run-scoped token vault: interfaces, encrypted SQLite implementation, key providers (local, Azure Key Vault), rotation, purge, auditing, pseudonyms.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-12-token-vault.md](./epic-12-token-vault.md): tasks 12.1-12.9

## Allowed internal imports

- `@harness/schemas`, `@harness/telemetry`, `@harness/crypto`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Also touched by

- 8.1 ([epic-08](../telemetry/epic-08-leak-sentinel.md)) extends `VaultReader` with `version(runId)`.

## Rules

- Raw sensitive values live only here (encrypted, own DB file). Never log, snapshot, or put them in errors; use obviously fake values in tests (`alice@example.test`).
- Consumers receive the narrowest interface: `VaultWriter`, `VaultResolver`, `VaultReader`, or `VaultAdmin`. Do not widen.
- Lookup uses a keyed HMAC, never an unkeyed hash of the value.
- Every detokenization is audited (metadata only).

## Testing

- Shared vault conformance suite; canary grep of the DB file bytes.

## Gotchas

- The vault has its own DB file. Never put vault tables in the event store DB, even "temporarily".
- The leak sentinel gets `VaultReader` only, the detokenizer and UI get `VaultResolver` only. Passing the full vault "for convenience" breaks separation of duties.
- Active runs are never purged; purge is idempotent and `resolve` after purge returns `undefined`.
- Concurrent `put`s of the same value must yield one token (test it).
