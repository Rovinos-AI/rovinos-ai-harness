# AGENTS.md: .github

GitHub configuration: CODEOWNERS, PR and issue templates, Dependabot, and the CI workflow (`workflows/ci.yml`) with its shared setup action (`actions/node-setup`).

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
- Workflows run on `pull_request`, never `pull_request_target`, with `permissions: contents: read`, and `persist-credentials: false` on checkout.
- Pin every third-party action to a full commit SHA, with the tag in a trailing comment.
- CI job names are fixed: `static`, `unit`, `integration`, `gates`. Branch protection requires them by name.

## Testing

- `scripts/ci/verify-workflow.test.ts` parses the workflow and the setup action and asserts their structure and security settings.
