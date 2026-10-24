# AGENTS.md: docs

User and contributor documentation.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-21-docs-examples-release.md](./epic-21-docs-examples-release.md): tasks 21.1-21.10

<!-- END GENERATED: agents-index -->

## Boundaries

- Markdown only (plus generated images).

## Rules

- Docs are tested: runnable shell blocks are marked `<!-- test:run -->` and executed in CI; links, anchors, and Mermaid diagrams are validated.
- No absolute security claims; the claims linter blocks phrases like "cannot leak". State guarantees with evidence and assumptions, and list known gaps.
- Generated API docs (`docs/api/`) are gitignored and built in CI.
- ADRs live in `docs/decisions/` and are indexed.

## Testing

- `yarn check:docs` (links, mermaid, claims, markdownlint).
