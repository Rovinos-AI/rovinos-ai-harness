# AGENTS.md: packages/context

Context strategies (naive, sliding window, summarizing), token counting, offloading, plan tools, comparison.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-15-context-strategy.md](./epic-15-context-strategy.md): tasks 15.1-15.8

## Allowed internal imports

- `@harness/schemas`, `@harness/telemetry`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Rules

- `ContextStrategy.build` is pure over the event log. Side effects (summarizing, writing files) happen in explicit run-loop steps that record events.
- Tool calls and their results are one atomic group; never split them.
- Any change in a strategy's output for the same input requires a new `version` Code (golden/version guard test).
- Offloaded files and previews contain tokenized content only.

## Testing

- Transcript goldens; purity tests with throwing fakes.
