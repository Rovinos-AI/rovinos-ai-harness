# AGENTS.md: packages/store-sqlite

SQLite `EventStore` implementation and SQLite-specific migrations, worker opener, and tests. See
`../store/epic-07-event-store.md` task 7.15 for the package split.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- None. See `docs/engineering/tasks/README.md`.

## Allowed internal imports

- `@rovinos/schemas`, `@rovinos/store`. Nothing else from `@rovinos/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Rules

- Keep SQLite schema changes in this package's migrations directory.
- Every adapter behavior change must pass both shared store conformance suites.

## Testing

- SQLite adapter and both conformance suites run in the unit project.
