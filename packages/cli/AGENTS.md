# AGENTS.md: packages/cli

The `harness` CLI. Epic 20 defines the framework; commands are added by the epics that own them.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [TASKS.md](./TASKS.md) (specs in other folders): tasks 1.3, 2.10, 2.13, 6.6, 9.1, 9.5, 12.3, 12.5, 13.9, 15.7, 16.8, 17.5, 17.8, 18.1, 20.2, 20.4, 2.14, 6.8, 24.3, 25.6

## Allowed internal imports

- `@harness/schemas`, `@harness/telemetry`, `@harness/crypto`, `@harness/store`, `@harness/vault`, `@harness/pii`, `@harness/models`, `@harness/context`, `@harness/policy`, `@harness/mcp`, `@harness/sandbox`, `@harness/core`, `@harness/config`, `@harness/control-plane`, `@harness/host`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Rules

- Only `src/output.ts` writes to stdout/stderr. `--json` must print exactly one JSON document to stdout.
- Print error *codes*, never messages or content. Content requires explicit flags (`--show-content`, `--show-args`, `--reveal`).
- Exit codes come from the single table in `exit-codes.ts` and are documented in `docs/cli.md`.
- Register commands through `CommandModule`; lazy-import heavy modules.

## Testing

- Call `main(argv, fakeCtx)`; assert output, JSON shape, and exit codes.
