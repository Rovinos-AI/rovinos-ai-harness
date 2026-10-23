# AGENTS.md: pipelines

The Azure Pipelines configuration is retained only for the nightly Azure Key Vault live test. GitHub Actions (`.github/workflows/ci.yml`) is the only pull request CI.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [TASKS.md](./TASKS.md) (specs in other folders): tasks 1.4, 1.8, 16.11, 21.6, 24.8

<!-- END GENERATED: agents-index -->

## Boundaries

- YAML only.

## Rules

- The nightly pipeline runs only the live Azure Key Vault test; it does not run on pull requests.
- No literal secrets; use pipeline variables and Azure service connections.

## Testing

- `scripts/ci/verify-nightly.test.ts` parses the YAML and asserts the scheduled live test configuration.
