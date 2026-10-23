# AGENTS.md: docs/engineering

Engineering planning docs: conventions, task specs, and the task index.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [tasks/epic-01-foundation.md](./tasks/epic-01-foundation.md): tasks 1.1, 1.1.1, 1.2-1.12

<!-- END GENERATED: agents-index -->

## Boundaries

- Docs only.

## Rules

- `CONVENTIONS.md` is the shared reference for every task spec.
- Task specs live next to the code they describe; `tasks/README.md` is the index. Do not duplicate spec files here.
- When a PR completes a task, add an empty marker file at `docs/progress/<task-id>` (the threat-case checker reads it).
