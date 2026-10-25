# AGENTS.md: packages/policy

Tool-call policy engine: schema, deterministic evaluator, approval payloads, sweeper, linting.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-17-policy-engine-and-approvals.md](./epic-17-policy-engine-and-approvals.md): tasks 17.1-17.9

## Allowed internal imports

- `@rovinos/schemas`, `@rovinos/telemetry`. Nothing else from `@rovinos/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Rules

- The model never decides. Policy runs in code on tokenized args and never sees raw values.
- Most restrictive decision wins (deny > ask > allow); the default decision can only be `ask` or `deny`.
- The evaluator is pure and total. Keep property tests (adding a deny never loosens).
- Policy free text (descriptions) never goes to telemetry.

## Testing

- Precedence table tests; `harness policy test` fixtures in `examples/policy-tests/`.
