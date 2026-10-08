# AGENTS.md: pipelines

Azure Pipelines templates used by `azure-pipelines.yml` and the nightly pipeline.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [TASKS.md](./TASKS.md) (specs in other folders): tasks 1.4, 1.8, 16.11, 21.6, 24.8

<!-- END GENERATED: agents-index -->

## Boundaries

- YAML only.

## Rules

- Stage names are fixed: `static`, `unit`, `integration`, `gates`, `release`. Add steps, never rename stages.
- No literal secrets; use variable groups and Key Vault tasks.
- Teardown steps use `condition: always()`; test results use `succeededOrFailed()`.
- Required status check names are documented in `docs/maintainers/branch-protection.md`; changing them breaks branch protection.

## Testing

- `scripts/ci/verify-pipeline.test.ts` parses the YAML and asserts structure.
