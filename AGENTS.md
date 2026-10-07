# AGENTS.md (repository root)

Rovinos AI Harness: an open source, TypeScript, container-native agent harness with an event-sourced run log, metadata-only telemetry, PII tokenization at every boundary, MCP Apps human-in-the-loop approvals, and Azure Pipelines CI. License: Apache-2.0.

Instruction precedence: explicit user instructions, then the nearest `AGENTS.md` to the files you edit, then this file. Folder files add rules; they never relax these. This file is always in effect, so folder files do not repeat it.

## Current state
The repo holds specs and agent instructions only; there is no pnpm workspace yet. Task 1.1 (`docs/engineering/tasks/epic-01-foundation.md`) creates `package.json`, the workspace, and the root scripts listed under Commands. Until it lands, those commands do not exist: do not invent scripts or stub a workspace outside task 1.1. `docs/progress.json` is empty because no task is complete.

## How to work here
1. Pick one task id (for example `7.3`). Index: `docs/engineering/tasks/README.md`. Specs sit next to the code (`packages/<name>/epic-*.md`); `epic-01` lives in `docs/engineering/tasks/`, `epic-21` in `docs/`. Each folder's `AGENTS.md` lists the specs and task ids that touch it.
2. Read `docs/engineering/CONVENTIONS.md`, the nearest folder `AGENTS.md`, and the task spec. The spec lists inputs, outputs, tests, and acceptance criteria. Meet all of them and do not add scope.
3. One task per PR. Title: `[7.3] <task name>`. Commits signed off (`git commit -s`).
4. Write the tests the task lists, in the Azure Pipelines stage it names: `static`, `unit`, `integration`, `gates`.
5. In the PR description list: task id, what changed, how it was tested, any "(verify)" decisions, follow-ups.
6. Add the task id to `docs/progress.json` (the threat-case checker reads it).

## Repo map
- `packages/*`: libraries and apps. Allowed internal imports per package are in `docs/engineering/layers.json` (rendered into CONVENTIONS section 1 and each package's `AGENTS.md`; lint enforces it). No cycles.
- `infra/*`: compose, collector, dashboards, Kusto, alerts, k8s examples. `security/`: scanner rules and policies. `scripts/`: CI and generator scripts. `test/`: cross-package tests. `docs/`: documentation. `examples/`: runnable examples. `pipelines/`: Azure templates. `tools/eslint-plugin-harness/`: custom lint rules.

## Commands
- Install: `pnpm install --frozen-lockfile` (Node 22, pnpm 9+).
- Repo-wide: `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration` (needs compose services), `pnpm test:canary`, `pnpm test:replay`.
- Scope tests to one folder by passing its path, which is forwarded to Vitest: `pnpm test:unit packages/core`, `pnpm test:integration packages/store`.
- Checks: `pnpm check:spdx`, `pnpm check:dco`, `pnpm check:licenses`, `pnpm lint:telemetry`, `pnpm docs:catalog --check`, `pnpm gen:collector --check`.
- Agent index: `node scripts/gen-agents-index.mjs` regenerates the generated blocks in folder `AGENTS.md` files and CONVENTIONS section 1; `--check` fails on drift or broken links. Tests: `node --test scripts/*.test.mjs`. Folder `AGENTS.md` files list only extra, folder-specific commands.

## Rules that always apply
- TypeScript strict. No `any`, no non-null assertions, no `console.*`. Zod at every boundary. Inject `Clock`, `IdGenerator`, randomness.
- Errors are typed with a closed `code`. Telemetry and logs carry codes, never messages.
- Every source, shell, and YAML file starts with `// SPDX-License-Identifier: Apache-2.0` (or `#`).
- Telemetry: create spans only via `defineSpan`; attributes are Ids, Codes, enums, integers, booleans. Never export prompts, completions, tool arguments or results, exception messages, URLs with query strings, or file paths.
- Privacy: raw sensitive values exist only in the vault and in-flight memory at the tool boundary. Events, context, snapshots, files, and telemetry carry tokens. Tests use synthetic data only.
- Approvals: the model never decides authority. Policy runs in code on tokenized args; approvals are human decisions recorded in the log.
- Sandbox: never mount `docker.sock`; argv only, no shell strings; default deny.
- Never commit secrets, real keys, or real personal data. Never edit generated files (including the `BEGIN GENERATED` blocks in `AGENTS.md`) by hand; regenerate and commit.
- Do not weaken a guarantee, remove a negative-control test, or relax a lint rule to make a change pass.

## Done means
CONVENTIONS section 8: one task per PR, signed-off commits, the tests the spec lists in the stage it names, SPDX headers, docs updated, task id in `docs/progress.json`, and `node scripts/gen-agents-index.mjs --check` passing.

## Stop and ask when
- The task spec is ambiguous or contradicts CONVENTIONS or an `AGENTS.md`.
- A "(verify)" item turns out different from the spec (record the decision in the PR description).
- The change would weaken any rule under "Rules that always apply" or a folder's rules.
- The change touches a public interface, a schema listed in CONVENTIONS section 4, a boundary in `layers.json`, or a security-relevant default.
- A task is growing beyond one PR (split it and say so).

Otherwise prefer the simplest behavior that satisfies the acceptance criteria, and note the choice in a code header comment and the PR.
