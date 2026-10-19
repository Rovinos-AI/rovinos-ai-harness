# AGENTS.md: packages/sdk

Public programmatic API (`@harness/sdk`), the run queue and workers it drives, multi-replica deployment, quotas, and performance budgets (epic 24).

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-24-run-service-and-scaling.md](./epic-24-run-service-and-scaling.md): tasks 24.1-24.10

## Allowed internal imports

- `@harness/schemas`, `@harness/telemetry`, `@harness/crypto`, `@harness/store`, `@harness/store-postgres`, `@harness/store-sqlite`, `@harness/vault`, `@harness/pii`, `@harness/models`, `@harness/context`, `@harness/policy`, `@harness/mcp`, `@harness/sandbox`, `@harness/core`, `@harness/config`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Boundaries

- This package is the only semver-stable surface. Everything exported from `src/index.ts` is public; keep internals unexported.
- Queue tables live in `packages/store`, the worker loop in `packages/core`, and the `harness worker` command in `packages/cli`; epic 24 tasks touch those folders under their own AGENTS.md rules.

## Rules

- Return metadata and `SafeEvent`s by default. Content access is explicit, tokenized, and documented as sensitive.
- Public surface changes update the committed `.d.ts` snapshot and need a changeset with the right semver bump (21.6).
- Queue rows hold ids and codes only; run input is recorded as events before a job is enqueued.
- Multi-instance mode requires Postgres for the store, vault, and queue; never weaken the startup validation that enforces it.

## Gotchas

- A worker that loses its queue lease must stop appending; the store's `seq` conflict is the backstop, not the primary signal. Abort the run's controller on heartbeat failure.
- Quota usage is written in the same transaction as the `model_response` that caused it. Updating it afterwards risks lost or double-counted spend.
- `watch` and MCP resource notifications carry ids and safe events only; never push message content to subscribers.
