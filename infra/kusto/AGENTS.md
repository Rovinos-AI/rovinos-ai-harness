# AGENTS.md: infra/kusto

Azure Data Explorer (Kusto) schema and queries.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [TASKS.md](./TASKS.md) (specs in other folders): tasks 11.2, 11.4
<!-- END GENERATED: agents-index -->

## Boundaries
- Configuration and KQL only.

## Rules
- Read only cataloged attributes (see `docs/telemetry/attribute-catalog.md`).
- Keep column access in the `let` helper at the top of each query so schema drift needs one change.
- `schema.kql` uses `.create-merge` and sets retention for every table.
- Query contract tests run against the emulator with committed goldens; update goldens deliberately.

## Testing
- Emulator integration tests; fixture regeneration script must be deterministic.
