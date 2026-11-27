# AGENTS.md: packages/cli

The `harness` CLI. Epic 20 defines the framework; commands are added by the epics that own them.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Allowed internal imports

- `@rovinos/eval`, `@rovinos/schemas`, `@rovinos/telemetry`, `@rovinos/crypto`, `@rovinos/store`, `@rovinos/store-postgres`, `@rovinos/store-sqlite`, `@rovinos/vault`, `@rovinos/pii`, `@rovinos/models`, `@rovinos/context`, `@rovinos/policy`, `@rovinos/mcp`, `@rovinos/sandbox`, `@rovinos/core`, `@rovinos/config`, `@rovinos/control-plane`, `@rovinos/host`, `@rovinos/replay`. Nothing else from `@rovinos/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Rules

- Only `src/output.ts` writes to stdout/stderr. `--json` must print exactly one JSON document to stdout.
- Print error *codes*, never messages or content. Content requires explicit flags (`--show-content`, `--show-args`, `--reveal`).
- Exit codes come from the single table in `exit-codes.ts` and are documented in `docs/cli.md`.
- Register commands through `CommandModule`; lazy-import heavy modules.

## Testing

- Call `main(argv, fakeCtx)`; assert output, JSON shape, and exit codes.
