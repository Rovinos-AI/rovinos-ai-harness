# AGENTS.md (repository root)

Rovinos AI Harness: an open source, TypeScript, container-native agent harness with an event-sourced run log, metadata-only telemetry, PII tokenization at every boundary, MCP Apps human-in-the-loop approvals, and Azure Pipelines CI. License: Apache-2.0.

Instruction precedence: explicit user instructions, then the nearest `AGENTS.md` to the files you edit, then this file. Folder files add rules; they never relax these. This file is always in effect, so folder files do not repeat it.

## Current state
The Yarn workspace and `@harness/schemas` package are scaffolded; later tasks add the remaining packages and tooling. `docs/progress.json` tracks completed tasks.

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
- Install: `mise trust && mise install && yarn install --immutable` (Node 22, Corepack, and Yarn 4 are pinned).
- Repo-wide: `yarn lint`, `yarn typecheck`, `yarn test:unit`, `yarn test:integration` (needs compose services), `yarn test:canary`, `yarn test:replay`.
- Scope tests to one folder by passing its path, which is forwarded to Vitest: `yarn test:unit packages/core`, `yarn test:integration packages/store`.
- Checks: `yarn check:spdx`, `yarn check:dco`, `yarn check:licenses`, `yarn lint:telemetry`, `yarn docs:catalog --check`, `yarn gen:collector --check`.
- Agent index: `yarn gen:agents` regenerates the generated blocks in folder `AGENTS.md` files and CONVENTIONS section 1; `yarn check:agents` checks for drift and broken links and runs its tests. Folder `AGENTS.md` files list only extra, folder-specific commands.

## Rules that always apply
- TypeScript strict. No `any`, no non-null assertions, no `console.*`. Zod at every boundary. Inject `Clock`, `IdGenerator`, randomness.
- Errors are typed with a closed `code`. Telemetry and logs carry codes, never messages.
- Every source, shell, and YAML file starts with `// SPDX-License-Identifier: Apache-2.0` (or `#`).
- Telemetry: create spans only via `defineSpan`; attributes are Ids, Codes, enums, integers, booleans. Never export prompts, completions, tool arguments or results, exception messages, URLs with query strings, or file paths.
- Privacy: raw sensitive values exist only in the vault and in-flight memory at the tool boundary. Events, context, snapshots, files, and telemetry carry tokens. Tests use synthetic data only.
- Approvals: the model never decides authority. Policy runs in code on tokenized args; approvals are human decisions recorded in the log.
- Sandbox: never mount `docker.sock`; argv only, no shell strings; default deny.
- Lint: `yarn lint` must pass with zero errors and zero warnings. Never relax a rule to make code pass; inline suppressions need `-- <reason>` and some rules cannot be suppressed at all (task 1.2).
- Contracts: every data contract is one Zod schema with `z.infer` types; parse untrusted JSON and YAML only with `parseJson`/`parseYaml` (CONVENTIONS 3.10).
- MCP: target protocol 2026-07-28 with the TypeScript SDK v2 and MCP Apps (`io.modelcontextprotocol/ui`) for every human-facing UI (CONVENTIONS section 10). Never use the v1 SDK or deprecated MCP features.
- Never commit secrets, real keys, or real personal data. Never edit generated files (including the `BEGIN GENERATED` blocks in `AGENTS.md`) by hand; regenerate and commit.
- Do not weaken a guarantee, remove a negative-control test, or relax a lint rule to make a change pass.

## Done means
CONVENTIONS section 8: one task per PR, signed-off commits, `yarn lint` and `yarn typecheck` clean (zero errors and zero warnings), the tests the spec lists in the stage it names, SPDX headers, docs updated, task id in `docs/progress.json`, and `yarn check:agents` passing.

## Stop and ask when
- The task spec is ambiguous or contradicts CONVENTIONS or an `AGENTS.md`.
- A "(verify)" item turns out different from the spec (record the decision in the PR description).
- The change would weaken any rule under "Rules that always apply" or a folder's rules.
- The change touches a public interface, a schema listed in CONVENTIONS section 4, a boundary in `layers.json`, or a security-relevant default.
- A task is growing beyond one PR (split it and say so).

Otherwise prefer the simplest behavior that satisfies the acceptance criteria, and note the choice in a code header comment and the PR.
