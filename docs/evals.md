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

An `llm_judge` rubric is a YAML list of uniquely identified, positively weighted
criteria, each with a description. The grader sends a bounded view derived from
tokenized run events through the configured model gateway with a strict verdict
schema; it stores only the weighted score, codes, vote counts, and judge usage.
The optional `votes: 3` setting enables majority voting. Configure the grader with
a gateway that uses the trial's cassette mode to record or replay judge calls.

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
zero-based trial index. These attributes are omitted from ordinary runs. In-process
evals default to an in-memory trace provider; set `exportTelemetry: true` only when
the caller has configured its explicit export pipeline. The Docker executor captures
container stdout/stderr and the grader checks `telemetry.json` in the trial directory
when a collector writes that file. `no_canary_leak` scans all captured spans, process
output, event and vault database bytes, and workspace files; raw captured content is
kept out of trial results.

## Running a suite from the CLI

`harness eval run <suite>` runs the suite and writes `trials.jsonl`,
`eval-report.json`, `eval-report.md`, and `junit.xml` under `--out`. The default output
directory is `./eval-out/<timestamp>`, where the timestamp comes from the CLI clock.
Use `--model provider/model[,provider/model]` to create one variant per model,
`--trials <n>` to override per-task trial counts, and `--filter <tag|taskId>` to select
tasks. `--concurrency`, `--seed`, `--fail-under`, and `--max-cost-usd` control the run;
the cost cap prevents new trials from starting after completed trials exceed it, and
the command exits with code 6 when trials were skipped.

Use `--variants <file>` instead of `--model` to run a YAML-defined set of variants.
Each file has at least two unique `variants`, with `id`, optional `route` model
references, `contextStrategy`, `policyFile`, and `configOverrides`. Policy paths are
relative to the variants file. Config overrides are merged into and validated against
the loaded harness configuration before trials start; only the trial-supported fields
(`run`, `roles`, and `models`) can be overridden, so variants cannot replace each
trial's isolated store, vault, keys, or PII settings.
See [`examples/evals/variants.yaml`](../examples/evals/variants.yaml) for synthetic
routes.

`--cassette replay` is the default for in-process runs and reads
`<suite directory>/cassettes/<taskId>/<variantId>.json`; a missing entry fails with a
cassette miss instead of calling a live provider. `--cassette off` defaults to Docker
isolation. `--isolation inprocess|docker` selects the executor explicitly, and
`--export-telemetry` opts into the caller-configured telemetry exporters (off by default).
Docker uses `ghcr.io/rovinos-ai/harness:<CLI version>` unless `HARNESS_EVAL_IMAGE`
overrides the image. Docker execution is currently blocked by default-deny network
isolation: `--isolation docker --cassette off` fails before trials start with
`eval_docker_live_model_unavailable`. Network access and credential forwarding are
tracked separately in [issue #660](https://github.com/Rovinos-AI/rovinos-ai-harness/issues/660).

In-process trials run `test_command` graders through the trial's sandbox backend,
using argv only, a 60-second timeout, and the same isolated project workspace as
the run. Fixtures are copied into that workspace before execution.
The development in-process backend is not an isolation boundary: its resource and
network restrictions are limited. Use a configured sandbox runner for enforcement.

`llm_judge` uses the configured model gateway, the grader's model and vote count,
and the trial's cassette mode. Judge cassettes are stored separately as
`cassettes/<task>/<variant>.judge.json`. Replay constructs no live providers and
resolves no provider credentials; a missing judge cassette reports `judge_error`
and `cassette_miss`. Only structured verdicts are recorded, never judge reasoning.
Judge tokens and cost are included once in trial usage and reports, and count
toward `--max-cost-usd` before the worker schedules its next trial. Trials already
in flight may exceed the cap.

Docker judge suites fail before execution with `eval_llm_judge_docker_unavailable`.
The general Docker restrictions above remain in place; this integration does not
enable Docker networking or credential forwarding.

The CLI summary contains task and variant identifiers, pass rates, cost, and steps.
With global `--json`, stdout contains one validated content-free report document;
Markdown, JSON, JUnit, and trial JSONL files contain metadata and grader codes only.

## Comparing reports

`harness eval compare a/eval-report.json b/eval-report.json` compares two reports.
If either report contains multiple variants, select one with `--variant-a <id>` or
`--variant-b <id>`. `--seed <n>` controls the deterministic 2,000-resample bootstrap.
The output includes per-task and overall pass rates, cost, steps, and latency, with
mean differences (`B - A`), percentile 95% confidence intervals for numeric metrics,
two-sided Fisher exact p-values for pass rates, and Holm-adjusted task p-values.
The reported effect size is the difference in the metric's original units (percentage
points for pass rate). Results with fewer than 10 trials on either side are labeled
`inconclusive`. JSON mode emits a validated comparison report.

Reports retain each trial's seed when available. Matching task/trial indexes with
equal seeds are counted as matched, but all significance tests and bootstrap intervals
treat the two samples as independent; no paired test is assumed.
