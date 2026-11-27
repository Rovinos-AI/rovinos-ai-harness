# AGENTS.md: packages/schemas

Zod schemas and inferred types shared by every package: events, field classification, config fragments, policies, messages, snapshots. Leaf package.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Allowed internal imports

- None (leaf package).
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Boundaries

- External code: `zod` (4.2 or later), `yaml`, `ajv` and `ajv-formats` (only inside the 1.12 helper for external JSON Schema), and the standard library. Files marked browser-safe (`app-span.ts`, `approval-tools.ts`, `messages.ts`) must not import Node APIs.

## Rules

- Every event field must be classified `meta` or `content` in `classification.ts`; the default for a new field is `content`. The exhaustiveness test must stay green.
- Adding an event type means: schema, classification, SafeEvent mapping decision (`packages/telemetry/src/safe-event.ts`), goldens.
- Config fragments live here but are *owned* by the package that consumes them; keep the owning task id in a header comment.
- Strict objects (`.strict()`) everywhere; no `z.any()`; use `Id`, `Code`, `Sha256Hex` primitives instead of bare strings.

## Testing

- Round-trip tests per schema; exhaustiveness test for classification; regex tables for primitives.
