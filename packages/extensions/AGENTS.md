# AGENTS.md: packages/extensions

Optional public authoring helpers for SDK extension definitions and explicit registrations.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- None. See `docs/engineering/tasks/README.md`.

## Allowed internal imports

- `@rovinos/sdk`. Nothing else from `@rovinos/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Boundaries

- The SDK owns extension contracts, validation, capability grants, and runtime enforcement.
- This package may depend on the SDK but the SDK and core must never depend on this package.

## Rules

- Reuse SDK schemas; never infer or create capability grants.
- Keep test-only helpers behind the `@rovinos/extensions/testing` export.
- Document extensions as trusted application code, not sandboxed plugins.

## Testing

- Run `yarn test:unit packages/extensions` and `yarn workspace @rovinos/extensions build`.
