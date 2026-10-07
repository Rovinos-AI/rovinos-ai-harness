# AGENTS.md: packages/schemas

Zod schemas and inferred types shared by every package: events, field classification, config fragments, policies, messages, snapshots. Leaf package.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [TASKS.md](./TASKS.md) (specs in other folders): tasks 1.1, 5.1, 5.4, 7.1, 8.4, 12.7, 13.1, 14.2, 15.1, 17.1, 20.1, 20.3, 23.1, 7.13, 17.9, 25.1

## Allowed internal imports
- None (leaf package).
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).
<!-- END GENERATED: agents-index -->

## Boundaries
- External code: `zod` and the standard library only. Files marked browser-safe (`app-span.ts`, `approval-tools.ts`, `messages.ts`) must not import Node APIs.

## Rules
- Every event field must be classified `meta` or `content` in `classification.ts`; the default for a new field is `content`. The exhaustiveness test must stay green.
- Adding an event type means: schema, classification, SafeEvent mapping decision (`packages/telemetry/src/safe-event.ts`), goldens.
- Config fragments live here but are *owned* by the package that consumes them; keep the owning task id in a header comment.
- Strict objects (`.strict()`) everywhere; no `z.any()`; use `Id`, `Code`, `Sha256Hex` primitives instead of bare strings.

## Testing
- Round-trip tests per schema; exhaustiveness test for classification; regex tables for primitives.
