# Harness build conventions (read first)

Every task file in this folder assumes this document. Task guidance says "see CONVENTIONS §N" instead of repeating it. If a task contradicts this file, the task wins for that task only; flag the conflict in the PR.

## 0. How to read a task

Each task has: Parent, Task Name, Task Description, Expected Inputs, Expected Output, Tests to write, Acceptance Criteria, Dependencies (libraries, tools, services), Items it depends on (other task IDs), and Implementation guidance.

- **Task ID** = `<epic>.<n>`, where `<epic>` equals the GitHub issue number of the parent epic (for example `7.3` belongs to issue #7 "Event store").
- **Size S** = one PR, about one developer-day, one observable "done when". If a task overruns, stop, split it, and note the split in the PR. Do not silently grow scope.
- "(verify)" next to an external API, package name, or image tag means: confirm against the installed version's types or docs before coding, adapt if different, and record the decision in the PR description.
- Never invent a requirement. If guidance is ambiguous, choose the simplest behavior that satisfies the acceptance criteria and document the choice in the code header comment.

## 1. Repository layout

pnpm workspaces. All packages are ESM, TypeScript, scope `@harness/`.

```
packages/
  schemas/        Zod schemas + inferred types: events, event field classification, config fragments, policies (leaf package: depends on nothing internal)
  crypto/         AES-GCM, HKDF, HMAC helpers (leaf package, created in task 12.2; no internal dependencies)
  telemetry/      span/log registry, allowlist processors, safe-event projection, leak-sentinel hook, sanctioned logger
  store/          EventStore interface, SQLite + Postgres adapters, conformance suite, snapshots, outbox
  vault/          token vault interface + implementations, key providers
  pii/            detectors, policy evaluation, tokenizer/detokenizer, boundary adapters
  models/         model gateway: normalized types, provider adapters, structured-output enforcement
  context/        ContextStrategy interface + strategies
  policy/         allow/ask/deny policy engine
  mcp/            MCP client + tool bridge, trace propagation
  host/           MCP Apps host bridge + reference web host
  app-telemetry/  browser-safe telemetry shim used inside MCP Apps
  approval-app/   reference approval MCP App
  control-plane/  harness-as-MCP-server (run control)
  sandbox/        tool execution backends
  core/           run loop, state machine, checkpointing, budgets, subagents
  replay/         replay + trace diff
  eval/           eval runner and graders
  config/         Zod config loading
  sdk/            public programmatic API (@harness/sdk), the only semver-stable surface
  cli/            `harness` CLI (bin)
infra/
  compose/        docker-compose files (dev, test, prod-like)
  collector/      OpenTelemetry Collector configs
  dashboards/     Datadog dashboards, Kusto queries
tools/
  eslint-plugin-harness/   custom lint rules
scripts/          repo scripts (CI checks, generators)
docs/             documentation
examples/         example configs, evals, apps
test/             cross-package integration, canary, replay tests
```

Dependency direction: the canonical allowlist is `docs/engineering/layers.json`. The ESLint import rule from task 1.2 reads it, and the table below is generated from it (`node scripts/gen-agents-index.mjs`). Summary: `schemas` and `crypto` are leaves; `telemetry` imports `schemas` only; mid-layer packages import `schemas` and `telemetry`, plus `crypto` (`store`, `vault`, `sandbox`, per task 12.2) or `vault` (`pii`, per epic 13); `core` imports all of those; `host`, `control-plane`, `replay`, `eval`, `cli` import `core` and below. No cycles. To change a boundary, edit `layers.json` in the same PR as the code that needs it.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
| Package | May import (`@harness/*`) |
|---|---|
| `schemas` | nothing (leaf) |
| `crypto` | nothing (leaf) |
| `app-telemetry` | nothing (leaf) |
| `telemetry` | `schemas` |
| `config` | `schemas` |
| `store` | `schemas`, `telemetry`, `crypto` |
| `vault` | `schemas`, `telemetry`, `crypto` |
| `pii` | `schemas`, `telemetry`, `vault` |
| `models` | `schemas`, `telemetry` |
| `context` | `schemas`, `telemetry` |
| `policy` | `schemas`, `telemetry` |
| `mcp` | `schemas`, `telemetry`, `crypto` |
| `sandbox` | `schemas`, `telemetry`, `crypto` |
| `approval-app` | `schemas`, `app-telemetry` |
| `core` | `schemas`, `telemetry`, `crypto`, `store`, `vault`, `pii`, `models`, `context`, `policy`, `mcp`, `sandbox` |
| `host` | `schemas`, `telemetry`, `core` |
| `control-plane` | `schemas`, `telemetry`, `crypto`, `store`, `vault`, `pii`, `models`, `context`, `policy`, `mcp`, `sandbox`, `core` |
| `replay` | `schemas`, `telemetry`, `crypto`, `store`, `vault`, `pii`, `models`, `context`, `policy`, `mcp`, `sandbox`, `core` |
| `eval` | `schemas`, `telemetry`, `crypto`, `store`, `vault`, `pii`, `models`, `context`, `policy`, `mcp`, `sandbox`, `core` |
| `cli` | `schemas`, `telemetry`, `crypto`, `store`, `vault`, `pii`, `models`, `context`, `policy`, `mcp`, `sandbox`, `core`, `config` |
| `sdk` | `schemas`, `telemetry`, `crypto`, `store`, `vault`, `pii`, `models`, `context`, `policy`, `mcp`, `sandbox`, `core`, `config` |
<!-- END GENERATED: agents-index -->

## 2. Tooling

- Node 22 LTS, pnpm 9+, TypeScript 5.x strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`), ESM only (`"type": "module"`, `.js` extensions in relative imports).
- Vitest (workspace with four projects, see §6), ESLint flat config with `typescript-eslint`, Prettier.
- Zod for every runtime boundary (config, events, tool args/results, model outputs, telemetry). Code against the stable common API only; check which Zod major the pinned MCP SDK expects before adding it (verify) and use one major across the repo.
- IDs: ULID (`ulid` package). Time: epoch milliseconds integers.
- Build: `tsc -b`. No bundler for libraries. The browser shim (`app-telemetry`) is bundled with `esbuild`.

## 3. Coding rules

1. No `any`, no non-null assertions, no `as` casts except in narrowly commented adapters.
2. Every exported function that crosses a package boundary validates input with Zod or accepts an already-validated type from `@harness/schemas`.
3. Inject nondeterminism: `Clock { now(): number }`, `IdGenerator { next(): string }`, `Random`. Production uses system implementations; tests use fakes from `packages/schemas/src/testing.ts` (created in task 1.1 as stubs, extended later).
4. Errors are classes extending `HarnessError` with a closed `code` (`^[a-z0-9_.-]{1,64}$`). Telemetry and logs carry only `code`, never `message`.
5. No `console.*`. Use the sanctioned logger from `@harness/telemetry` (task 20.5). Until it exists, use a local no-op logger interface and do not print.
6. Pure functions for decision logic (state transitions, policy evaluation, diffing). Side effects only at the edges (stores, network, fs).
7. Every file starts with `// SPDX-License-Identifier: Apache-2.0` (after a shebang if present).
8. Public interfaces have TSDoc. Non-obvious behavior has a header comment explaining why.
9. Keep PRs small: one task, one PR, title `[<task id>] <task name>`, commits signed off (`git commit -s`).

## 4. Domain model (shared vocabulary)

- **Run**: one execution of an agent task. Identified by `runId` (ULID). Has a monotonically increasing `seq` of events starting at 0.
- **Event**: immutable envelope `{ runId, seq, ts, type, v, traceId, spanId, segmentId, ... }` where `v` is the schema version of that event type. Event types (canonical set, extended only by adding to `@harness/schemas`): `run_created`, `run_input` (added by task 15.1), `run_status_changed`, `model_request`, `model_response`, `tool_intent`, `tool_result`, `approval_requested`, `approval_resolved`, `checkpoint_written`, `context_compacted`, `pii_action`, `budget_exceeded`, `subagent_spawned`, `subagent_completed`, `input_requested`, `input_resolved`, `input_completed` (added by task 25.1).
- **Schema evolution** (task 7.13): until the first tagged release, event schemas may change in place with golden updates. From the first release on, any change to an existing event type bumps its `v` and adds an upcaster; meta fields are never removed; new required fields need an upcaster default. `event-schema.lock.json` and the legacy-log tests enforce this.
- **Principal**: who acted, as a Code with a kind prefix (`token.<id>`, `cli.<name>`, `eval.simulated`, `system.sweeper`), recorded as `requestedBy` and `approverId` (task 17.9).
- **Field classification**: every event field is `meta` (safe for telemetry: IDs, enums, counts, timings, codes) or `content` (anything user- or model-derived). New fields default to `content`.
- **SafeEvent**: closed, `.strict()` projection of an event containing only `meta`-classified fields from an explicit allowlist. Built by `toSafeEvent()` in `@harness/telemetry`.
- **Code**: string matching `^[a-z0-9_.-]{1,64}$`. **Id**: 26-char ULID.
- **Token**: placeholder for a raw sensitive value, format `<TYPE_N>` (for example `<EMAIL_1>`), run-scoped. The **vault** maps tokens to raw values.
- **Boundary**: where data crosses a trust line: `model_input`, `tool_input`, `tool_output`, `storage`, `ui`.
- **Checkpoint**: event-log offset plus snapshot (compacted context, plan, workspace reference, `traceparent`).
- **Trusted server**: MCP server configured `trust: internal`; only these receive trace context.
- **Policy decision**: `allow | ask | deny`. `ask` suspends the run.
- **Human input**: a question for a human from an MCP server (elicitation, form or URL mode) or from the agent (`agent.ask_user`). Durable inputs suspend the run with reason `awaiting_input` (epic 25).

## 5. Telemetry rules (apply to every task that emits spans, logs, or metrics)

- Spans/log records are created only through registered definitions (`defineSpan`, task 4.1). Raw `tracer.startSpan` is banned by lint (task 4.5).
- Attribute names: `harness.*` for ours, `mcp.*` and `gen_ai.*` only where semantic conventions apply (pinned in task 4.7). Values: Id, Code, enum, integer, boolean. No free strings, no arrays of strings.
- Never export prompts, completions, tool arguments or results, exception messages, stack traces, URLs with query strings, or file paths.
- Metric attributes must be bounded (closed enums). Never put IDs on metrics.

## 6. Testing rules

Vitest workspace projects (defined in task 1.1):

| Project | File pattern | Runs in |
|---|---|---|
| unit | `*.test.ts` | `pnpm test:unit` (Azure stage `unit`) |
| integration | `*.int.test.ts` | `pnpm test:integration` (stage `integration`, needs compose services) |
| canary | `*.canary.test.ts` | `pnpm test:canary` (stage `gates`) |
| replay | `*.replay.test.ts` | `pnpm test:replay` (stage `gates`) |

Rules: unit tests do no network or disk outside a temp dir and use fake clock/ids. Tests are co-located (`foo.ts` + `foo.test.ts`) except cross-package tests in `test/`. Use table-driven tests for pure logic. Golden files live in `__golden__/` next to the test and are updated only via `UPDATE_GOLDEN=1`. Coverage floor 85% lines for new packages (enforced in task 1.4 once packages exist). Every bug fix adds a regression test.

## 7. Azure Pipelines stage map

`static` (lint, typecheck, SPDX, DCO, license scan) -> `unit` -> `integration` -> `gates` (canary, replay) -> `release` (tags only). Test results published as JUnit; coverage as Cobertura. Secrets only from variable groups or Key Vault, never in repo or logs. Emulator-based tests need no secrets; live-cloud tests are tagged `LIVE` and run only on the nightly schedule.

## 8. Definition of done (every task)

- [ ] Acceptance criteria all met; tests listed in the task exist and pass in Azure Pipelines.
- [ ] Types strict, lint clean, SPDX headers present, commits signed off.
- [ ] Public API documented (TSDoc); `docs/` updated if user-visible.
- [ ] No `console.*`, no `any`, no new dependency without a license from the allowlist (task 1.7).
- [ ] Telemetry added by the task follows §5.
- [ ] PR description lists: task ID, what changed, how tested, any "(verify)" decisions, any follow-ups discovered.

## 9. Glossary of file names reused across tasks

`packages/schemas/src/events.ts` (event Zod schemas), `packages/schemas/src/classification.ts` (field classification map), `packages/telemetry/src/registry.ts` (`defineSpan`), `packages/telemetry/src/safe-event.ts` (`toSafeEvent`), `packages/store/src/types.ts` (`EventStore`), `packages/core/src/state-machine.ts`, `packages/models/src/types.ts`, `packages/vault/src/types.ts`, `packages/policy/src/schema.ts`, `config/license-policy.json`, `infra/compose/docker-compose.yml`, `infra/collector/base.yaml`.
