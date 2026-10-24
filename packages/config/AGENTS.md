# AGENTS.md: packages/config

Configuration loading, validation, env overrides, secret references. See also `packages/cli`.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-20-config-and-cli-core.md](./epic-20-config-and-cli-core.md): tasks 20.1-20.5

## Allowed internal imports

- `@rovinos/schemas`. Nothing else from `@rovinos/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Rules

- Config files contain secret *references* (`env:`, `file:`, `akv:`), never secret values; inline secrets fail validation.
- Validation errors list paths and expected types, never the submitted values.
- `Secret` objects redact on `toString`, `toJSON`, and `inspect`.
- Fragments are owned by their consuming packages; compose them here only.

## Testing

- Loader tests with injected `readFile` and `env`.
