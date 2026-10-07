# AGENTS.md: test

Cross-package tests: canary gates, replay goldens, network isolation, hostile apps, security, quickstart.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [TASKS.md](./TASKS.md) (specs in other folders): tasks 2.11, 3.7, 5.6, 6.7, 8.5, 9.6, 10.4, 10.6, 18.7, 21.2, 22.5
<!-- END GENERATED: agents-index -->

## Boundaries
- May import any package's public exports.

## Rules
- Fixtures are synthetic; never real data. Canaries are generated per run from a seed.
- Every new sink, boundary, or log path adds a canary scenario in the same PR (`docs/canary-checklist.md`).
- Golden updates happen only through `pnpm replay:update` with an explanation in the PR.
- Negative controls (tests that must fail when protection is removed) are part of the suite; do not delete them.

## Testing
- Canary: `pnpm test:canary`. Replay: `pnpm test:replay`. Integration: `pnpm test:integration`.
