# AGENTS.md: packages/eval

Eval runner, graders, trajectory assertions, simulated human, reports, comparisons, invariants.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-16-eval-runner.md](./epic-16-eval-runner.md): tasks 16.1-16.12

## Allowed internal imports

- `@harness/schemas`, `@harness/telemetry`, `@harness/crypto`, `@harness/store`, `@harness/vault`, `@harness/pii`, `@harness/models`, `@harness/context`, `@harness/policy`, `@harness/mcp`, `@harness/sandbox`, `@harness/core`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Also touched by

- 22.6 ([epic-22](../../security/epic-22-security-hardening.md)).

## Rules

- Reports are metadata-only: scores, counts, codes. No transcripts or content.
- Each trial gets its own DB, vault, keys, and workspace. No shared state.
- All randomness is seeded. Statistics are implemented in-house with tests against reference values.
- Approval-integrity invariants run on every trial unless explicitly disabled (and flagged).

## Testing

- pass@k reference values; executor isolation tests; Docker executor tests tagged `@docker`.
