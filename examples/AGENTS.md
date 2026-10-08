# AGENTS.md: examples

Runnable examples: quickstart, approval demo, evals, policies, server configs.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [TASKS.md](./TASKS.md) (specs in other folders): tasks 6.1, 13.1, 14.14, 17.8, 21.2-21.4, 19.9, 24.1, 25.5

<!-- END GENERATED: agents-index -->

## Boundaries

- Examples only; not imported by packages.

## Rules

- All data is synthetic and declared as such (`containsRealData: false` where files support it).
- Examples run in CI (quickstart doc tests, eval replay, policy tests); an example that cannot run is a bug.
- Never include real keys. Use `.env.example` with placeholders.
