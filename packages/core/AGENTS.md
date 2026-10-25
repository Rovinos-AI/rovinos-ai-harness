# AGENTS.md: packages/core

Run loop, state machine, recorder, checkpoints, resume, approvals, budgets, cancel, shutdown, subagents, roles.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-02-run-loop.md](./epic-02-run-loop.md): tasks 2.1-2.14
- [epic-23-subagents-and-model-roles.md](./epic-23-subagents-and-model-roles.md): tasks 23.1-23.6

## Allowed internal imports

- `@rovinos/schemas`, `@rovinos/telemetry`, `@rovinos/crypto`, `@rovinos/store`, `@rovinos/store-postgres`, `@rovinos/store-sqlite`, `@rovinos/vault`, `@rovinos/pii`, `@rovinos/models`, `@rovinos/context`, `@rovinos/policy`, `@rovinos/mcp`, `@rovinos/sandbox`. Nothing else from `@rovinos/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Rules

- Depend on ports (`ModelPort`, `ToolPort`, `ContextPort`, `PolicyPort`), not concrete packages, inside the loop.
- Durability rule: a tool never executes before its `tool_intent` is durably appended.
- All events are created through `RunRecorder`. A `seq_conflict` means stop and inspect the log tail; never retry blindly.
- State transitions and folds are pure functions. Inject `Clock` and `IdGenerator`.
- Keep the crash-injection suite (task 2.11) green; extend it when adding steps that append events.

## Testing

- Crash-injection matrix; golden event sequences; fake ports in `src/testing/`.

## Gotchas

- Retrying after `seq_conflict` is the classic bug: a conflict means another worker or a cancel acted. Stop, re-read the log tail, and decide; never loop.
- On resume, a dangling `tool_intent` without `tool_result` must not re-execute a non-idempotent tool without a decision. `rerun` reuses the same `callId` and appends only `tool_result`, never a second intent.
- A checkpoint's snapshot and its event are atomic: on conflict neither is written. `atSeq` is the seq of the checkpoint event itself.
- Each (re)start is a new `segmentId` with a new root span linked to the previous one. Don't reuse the old span context.
- Human inputs (epic 25) follow the approval pattern: record `input_requested` before any channel sees it, suspend with `awaiting_input` for durable inputs, and never expose a model-visible way to answer.
