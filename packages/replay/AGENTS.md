# AGENTS.md: packages/replay

Replay a recorded run from its log and diff behavior.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-09-replay.md](./epic-09-replay.md): tasks 9.1-9.6

## Allowed internal imports

- `@rovinos/schemas`, `@rovinos/telemetry`, `@rovinos/crypto`, `@rovinos/store`, `@rovinos/vault`, `@rovinos/pii`, `@rovinos/models`, `@rovinos/context`, `@rovinos/policy`, `@rovinos/mcp`, `@rovinos/sandbox`, `@rovinos/core`. Nothing else from `@rovinos/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Rules

- Replay never calls real models, tools, or humans; it serves recorded data and uses a fresh temp store and vault.
- Diffs are content-free: safe projections and meta values only.
- `--update-baseline` is refused in CI unless forced; never auto-update goldens.
- Golden and cassette data must be synthetic and declare `containsRealData: false`.

## Testing

- `*.replay.test.ts` golden runs plus a mutation check proving the gate can fail.
