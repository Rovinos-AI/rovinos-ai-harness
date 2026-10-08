# AGENTS.md: .github

GitHub configuration: CODEOWNERS, PR and issue templates, Dependabot.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [TASKS.md](./TASKS.md) (specs in other folders): tasks 1.9, 1.10

<!-- END GENERATED: agents-index -->

## Boundaries

- Configuration only.

## Rules

- Templates mirror CONVENTIONS section 8 and the task spec fields.
- CODEOWNERS covers security-sensitive paths (`packages/telemetry`, `packages/pii`, `infra/collector`, `packages/sandbox`).
- No secrets or tokens in workflow or config files.
