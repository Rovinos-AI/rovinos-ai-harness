# Evaluation suites

Eval suites define versioned tasks and graders for repeatable harness evaluations.
The loader accepts TypeScript (`.suite.ts` or `.ts`), YAML (`.yaml` or `.yml`), and
JSON (`.json`) files. Every format is validated by the same strict Zod contract;
`schemaVersion` must be `1`, and task ids must be unique.

## Suite shape

A suite has `schemaVersion: 1` and a `tasks` array. Each task has a lowercase code
`id`, an `input.goal`, `graders`, and lowercase code `tags`. Optional fields
configure fixture workspaces, tools, models, context strategy, budgets, simulated
human behavior, canaries, and trial counts. See
[`examples/evals/basic.suite.ts`](../examples/evals/basic.suite.ts) for a synthetic
TypeScript example.

Grader types are `file_diff`, `test_command`, `schema_valid`, `trajectory`,
`llm_judge`, and `no_canary_leak`. A `schema_valid.schemaRef` identifies a Zod
schema export as `module-path#exportName`. Relative suite paths for fixture
directories, policy files, expected files, and schema modules resolve against the
suite file's directory.

TypeScript suites are loaded with Node's built-in TypeScript type stripping,
available in the pinned Node 26 runtime; the eval package does not need a separate
`tsx` dependency. Type stripping only supports erasable TypeScript syntax, so
suites must avoid constructs that require JavaScript transformation, including
enums and parameter properties. TypeScript suites are executable code and should
only be loaded from trusted sources.

Simulated humans default to denying approvals. A script that uses default approval
must set `unsafeAutoApprove: true`; the schema rejects implicit auto-approval.

`defineSuite` validates an in-memory object and returns the inferred suite type.
`loadSuite` reads a supported suite file and returns a validated suite with its
relative file references resolved. Validation failures are `ContractError`s with
path and code issues, not the rejected input values.

## Running trials

`runEval(suite, variants, executor, { outDir })` runs every task/variant/trial
combination with a default concurrency of two. Its return value is ordered by suite,
variant, and trial index; `trials.jsonl` is appended as trials settle so interrupted
runs retain completed metadata. Trial workspaces, SQLite stores, and vaults live in
separate directories under `outDir/trials`.

`InProcessExecutor` accepts per-trial model, tool, and policy factories. Use these
factories for fakes or cassette-backed providers so trial state is not shared.
`DockerExecutor` uses the harness image with `--network none` by default, passes the
goal through container stdin, and enforces a wall-clock timeout. Containers drop all
capabilities, use a read-only root with a bounded no-exec `/tmp`, run as a non-root
user, and have configurable memory, CPU, and process-count limits. Generated configs
contain only secret references; each trial receives a fresh key through the
executor boundary. The runner is a package API; the shipped `harness eval` command
is tracked separately.

Root run spans created by either executor include the suite code, task code, and
zero-based trial index. These attributes are omitted from ordinary runs. Eval trial
results remain metadata-only; `no_canary_leak` scans event and vault database bytes,
workspace files, and the in-memory telemetry and process output passed in its
`GradeContext`. Use in-memory telemetry exporters for evals, and do not send eval
telemetry to external backends.
