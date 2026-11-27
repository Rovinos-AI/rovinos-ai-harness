# AGENTS.md: docs/engineering

Engineering planning docs: conventions, task specs, and the task index.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

<!-- END GENERATED: agents-index -->

## Boundaries

- Docs only.

## Rules

- `CONVENTIONS.md` is the shared reference for every task spec.
- Task specs live next to the code they describe; `tasks/README.md` is the index. Do not duplicate spec files here.
- When a PR completes a task, add an empty marker file at `docs/progress/<task-id>`.
