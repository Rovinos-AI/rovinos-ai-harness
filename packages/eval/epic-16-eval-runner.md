# Epic #16: Eval runner

**Goal:** make it easy to evaluate the harness, models, and harness variants on repeatable tasks, with deterministic graders, trajectory assertions, simulated humans, statistically sound reports, and a nightly Azure pipeline. Read `docs/engineering/CONVENTIONS.md` first, plus epics 2, 8 (canaries), 14 (cassettes), and 17 (approvals).
**Tasks:** 16.1 to 16.12, all size S.

Shared design for this epic:

- Package `packages/eval` plus the CLI command group `harness eval`. Evals run the **real** run loop, store, vault, and tokenizer; only models and tools may be replaced with cassettes or fakes.
- **Metadata-only results.** Reports contain scores, counts, codes, costs, and timings. Free text (rubric reasons, transcript snippets) is never written to reports; trial artifacts (event DB, workspace) are kept only with `--keep-artifacts` and are tokenized by construction.
- **Two executors:** `InProcessExecutor` (fast, default for cassette replay) and `DockerExecutor` (isolated, default for live-model evals). The eval CLI runs on a host or CI agent where Docker is available (it is not the sandboxed harness itself).
- Determinism: all randomness uses a seeded PRNG; cassette replay makes runs reproducible.

---

## 16.1 Eval task and suite schema

**Parent:** #16 Eval runner
**Task Description:** Define and load eval suites with Zod validation.
**Expected Inputs:** Suite files (`.suite.ts`, `.yaml`, `.json`).
**Expected Output:** `packages/eval/src/schema.ts` (`EvalTask`, `EvalSuite`, `GraderSpec`, `HumanScript`), `packages/eval/src/load.ts` (`loadSuite`, `defineSuite`), `examples/evals/basic.suite.ts`, package scaffold `packages/eval`, docs `docs/evals.md`.
**Dependencies:** `tsx` (to load TypeScript suites; verify), `yaml`.
**Items it depends on:** 14.2, 20.1, 15.8.
**Implementation guidance:**

1. `EvalTask = { id: Code, description?: string, input: { goal: string, metadata?: Record<Code, Code|number|boolean> }, workspace?: { fixtureDir: string }, tools?: { servers?: Code[]; builtins?: Code[] }, policyFile?: string, models?: ModelRef[], contextStrategy?: Code, budgets?: { maxSteps?, maxCostUsd?, maxWallClockMs? }, human?: HumanScript, canaries?: string[], graders: GraderSpec[], tags: Code[], trials?: int }`.
2. `GraderSpec` discriminated union: `file_diff { path, expectedFile?, expectedContains?, normalize?: "exact"|"whitespace" }`, `test_command { argv: string[], expectExit?: int }`, `schema_valid { schemaRef: string }`, `trajectory { assertions: TrajectoryAssertion[] }`, `llm_judge { rubricId: Code, rubric: string, model: ModelRef, passThreshold: number }`, `no_canary_leak {}`.
3. `defineSuite(suite)` validates and returns the typed suite. `loadSuite(path)` resolves relative paths against the suite file, loads `.ts` via dynamic import (through `tsx`), YAML/JSON via parsers, and validates with the schema. Duplicate task ids are rejected.
4. `schemaRef` for `schema_valid` points to an exported Zod schema in a module (`path#exportName`), loaded at grading time.
5. Version the format (`schemaVersion: 1`) and reject unknown versions.
**Tests to write:** valid and invalid suites; relative path resolution; duplicate ids; unknown grader types; TS suite loading; example suite validates.
**Acceptance Criteria:**

- [ ] Suites are validated with precise path-level errors.
- [ ] TS, YAML, and JSON formats load identically.
- [ ] Example suite committed and tested.

---

## 16.2 Runner with executors and result collection

**Parent:** #16 Eval runner
**Task Description:** Execute (task x variant x trial) combinations with isolation and collect trial results.
**Expected Inputs:** Suite, variants, options.
**Expected Output:** `packages/eval/src/{runner.ts,executor.ts,executors/inprocess.ts,executors/docker.ts,trial.ts}`.
**Dependencies:** Docker CLI on the host (for `DockerExecutor`), `execa` or `child_process`.
**Items it depends on:** 16.1, 2.10, 14.15.
**Implementation guidance:**

1. `interface TrialExecutor { run(trial: TrialSpec): Promise<TrialResult> }`. `TrialSpec = { suite, task, variantId, trialIndex, seed, workDir }`; `TrialResult = { status: "completed"|"failed"|"suspended"|"cancelled"|"error", runId, dbPath, workspaceDir, durationMs, usage: { inputTokens, outputTokens, costMicros }, exitCode }`.
2. Common setup per trial: fresh temp `workDir` (`<out>/trials/<task>/<variant>/<n>`), copy `workspace.fixtureDir` into `workDir/workspace`, fresh SQLite event store and vault files, generated config file for the variant (model routing, context strategy, policy file, budgets, cassette mode), keys from an ephemeral per-trial key (never reused).
3. `InProcessExecutor`: builds a runtime with `createRuntime(config, overrides)` in the same process; uses the cassette or fake providers; tools via the in-process or fake sandbox backend.
4. `DockerExecutor`: `docker run --rm --network none` (or the configured eval network) with the harness image, mounting `workDir` read-write, passing the config path and run input, and reading the resulting DB and workspace after exit; enforce a wall-clock timeout by killing the container.
5. Concurrency: bounded worker pool (`--concurrency`, default 2) with deterministic result ordering in outputs; a failing trial never aborts the suite (`status: "error"` with a code).
6. Results are written incrementally as JSON lines (`<out>/trials.jsonl`) so partial runs are recoverable.
**Tests to write:** in-process executor over a fake model/tool scenario; trial isolation (separate DB per trial, no shared state); failing trial recorded as `error` without aborting; docker executor integration test (marks `@docker`, runs in the integration stage); deterministic ordering under concurrency.
**Acceptance Criteria:**

- [ ] Trials never share databases, vaults, keys, or workspaces.
- [ ] A crash in one trial does not stop the suite.
- [ ] Results stream to disk as they complete.

---

## 16.3 Deterministic graders

**Parent:** #16 Eval runner
**Task Description:** Implement graders that need no model: file comparison, command execution, and schema validation.
**Expected Inputs:** Trial result and workspace.
**Expected Output:** `packages/eval/src/graders/{types.ts,file-diff.ts,test-command.ts,schema-valid.ts,index.ts}`.
**Dependencies:** none.
**Items it depends on:** 16.2, 19.2.
**Implementation guidance:**

1. `interface Grader { id: Code; grade(ctx: GradeContext): Promise<GradeResult> }`, `GradeResult = { graderId, pass: boolean, score: number (0..1), codes: Code[], counts?: Record<Code, number> }`. No free text in results.
2. `file_diff`: read the file from the trial workspace using the **safe path resolver** (19.5); compare to `expectedFile` content (exact, or whitespace-normalized by collapsing runs of whitespace and trimming) or check `expectedContains` substrings; codes `file_missing`, `content_mismatch`.
3. `test_command`: run `argv` through a `SandboxBackend` (in-process backend for the in-process executor, `docker run` with the workspace mounted read-only plus a writable tmp for the Docker executor) with a timeout (default 60 s); `pass` iff exit code equals `expectExit` (default 0); codes `exit_nonzero`, `timeout`.
4. `schema_valid`: extract the run's final answer (last `model_response` content text), `JSON.parse` it (using the tolerant extractor from 14.9), and validate with the Zod schema loaded from `schemaRef`; codes `no_json`, `schema_invalid`.
5. All graders are pure functions of the trial artifacts plus bounded I/O; no network.
**Tests to write:** each grader with passing and failing fixtures; traversal attempt in `file_diff.path` rejected; command timeout; schema grader with tokenized outputs (tokens accepted via 13.10 when configured); results contain no free text (property test with canary file content).
**Acceptance Criteria:**

- [ ] Graders are deterministic given the same artifacts.
- [ ] Results contain only codes and numbers.
- [ ] File access is path-safe.

---

## 16.4 Trajectory assertions

**Parent:** #16 Eval runner
**Task Description:** Assert properties of the event log, including privacy properties.
**Expected Inputs:** `Event[]` for the trial, task canaries.
**Expected Output:** `packages/eval/src/trajectory.ts` (`evaluateTrajectory`), assertion schema.
**Dependencies:** none.
**Items it depends on:** 16.3.
**Implementation guidance:**

1. Assertions (discriminated union): `tool_never_called { toolId }`, `tool_called { toolId, min?: int, max?: int }`, `max_steps { n }`, `no_denied_calls {}`, `approval_requested_for { toolId }`, `no_budget_exceeded {}`, `order { first: Code, then: Code }`, `no_raw_pii_at_model_input { canaries?: string[] }`, `final_status { status }`.
2. `evaluateTrajectory(events, assertions, ctx)` returns per-assertion `{ pass, code }`; the overall grade passes only if all pass.
3. `no_raw_pii_at_model_input` scans `model_request.messages` content from the log (already tokenized by design) for each canary substring and for the encoded variants from 8.6; any hit fails with code `raw_pii_at_model_input`. Because the log is post-tokenization, this checks the **stored** view; for provider-level checks the in-process executor additionally wraps the provider with a capture adapter and runs the same scan on what the provider received.
4. Pure functions over events; no I/O.
**Tests to write:** one pass and one fail test per assertion on constructed event logs; `order` with repeated tools; canary detection including encoded variants; capture-adapter test proving provider-side scan catches a bypassed tokenizer.
**Acceptance Criteria:**

- [ ] Each assertion type is covered by pass and fail tests.
- [ ] Privacy assertion detects leaks at both the stored and provider-facing views.
- [ ] Results contain codes only.

---

## 16.5 LLM-judge grader with schema-enforced verdicts

**Parent:** #16 Eval runner
**Task Description:** Add a rubric-based judge using the gateway with strict structured output.
**Expected Inputs:** Rubric, judge model, trial transcript view.
**Expected Output:** `packages/eval/src/graders/llm-judge.ts`, `JudgeView` builder, verdict schema.
**Dependencies:** none.
**Items it depends on:** 16.3, 14.10, 14.15.
**Implementation guidance:**

1. Rubric format: list of criteria `{ id: Code, description: string, weight: number }` in the task (`rubricId` plus inline `rubric` text parsed into criteria by a simple YAML block in the suite).
2. `JudgeView`: built from events (never raw store content): the goal (`run_input`), the final answer, a compact list of tool calls with outcomes (tool id, outcome code, abbreviated tokenized result up to 500 characters), and the run status. The judge model is a hosted provider by default, so the view is tokenized.
3. Verdict schema (enforced via the gateway with `outputSchema`): `{ criteria: { id: Code (enum from the rubric), met: boolean }[], verdict: "pass" | "fail" }`; **no free-text reasoning field**. Score = weighted fraction of met criteria; `pass` iff verdict is pass and score >= `passThreshold`.
4. Reliability: temperature 0; optional `votes: 3` with majority (config); record judge cost into trial usage; judge failures yield `pass: false` with code `judge_error` and are counted separately in reports.
5. Cassette support: judge calls go through the gateway so replay works.
**Tests to write:** fake provider verdicts mapped to scores; invalid verdict repaired or failing with `judge_error`; majority voting; view builder contains no canary beyond tokenized content and respects length limits; cassette replay determinism.
**Acceptance Criteria:**

- [ ] Judge output is schema-enforced with no free text stored.
- [ ] Judge errors are distinguishable from task failures.
- [ ] Works under cassette replay.

---

## 16.6 Simulated human

**Parent:** #16 Eval runner
**Task Description:** Drive approvals during evals through the same code path real humans use.
**Expected Inputs:** `HumanScript`, trial run suspended for approval.
**Expected Output:** `packages/eval/src/human.ts` (`SimulatedHuman`), loop integration in executors.
**Dependencies:** none.
**Items it depends on:** 16.2, 17.4, 2.9.
**Implementation guidance:**

1. `HumanScript = { rules: { match: { toolId?: Code, ruleId?: Code, pointerEquals?: { pointer: string, value: JsonValue } }, decision: "approve"|"deny"|"edit", edits?: Edit[] }[], default: "deny" | "approve", maxResumes: int (default 10) }`. `default: "approve"` requires `unsafeAutoApprove: true` in the script (explicit, flagged in reports).
2. After the executor sees the run suspended, `SimulatedHuman.step(runId)` loads pending approvals, matches rules in order against the payload (tokenized args), validates edits with `validateEdits` (17.4), calls `resolveApproval` (2.9), then the executor calls `resumeRun`; repeat until terminal or `maxResumes`.
3. Records counts: approvals approved, denied, edited (included in trial metrics, 16.7).
4. Never reveals tokens; matching works on tokenized args and `tokenType` semantics only.
**Tests to write:** rule matching precedence; approve/deny/edit flows end to end with fake tools; invalid edit surfaces an error code; `maxResumes` exhaustion; unsafe auto-approve flag required and surfaced in reports.
**Acceptance Criteria:**

- [ ] Simulated humans use `resolveApproval` exactly like the CLI.
- [ ] Auto-approve requires an explicit unsafe flag and is visible in reports.
- [ ] Runs that exceed `maxResumes` end with a clear code.

---

## 16.7 Metrics and reports

**Parent:** #16 Eval runner
**Task Description:** Compute per-trial metrics and aggregates and emit JSON, Markdown, and JUnit reports.
**Expected Inputs:** `trials.jsonl`, grade results.
**Expected Output:** `packages/eval/src/report/{metrics.ts,aggregate.ts,json.ts,markdown.ts,junit.ts}`, Zod schema `EvalReport` (versioned; `trials.jsonl` lines and baselines use Zod schemas too, CONVENTIONS 3.10).
**Dependencies:** none.
**Items it depends on:** 16.3, 16.4, 16.6.
**Implementation guidance:**

1. Per-trial metrics: status, passed, graders breakdown (codes), steps, input/output tokens, `costMicros`, wall time, `repairAttempts`, `fallbackDepth`, approvals (approved/denied/edited), denied tool calls, budget-exceeded flag, `unsafeAutoApprove` flag.
2. Aggregates per `(task, variant)`: trials `n`, passes `c`, pass rate, **pass@k** via the unbiased estimator `1 - C(n-c, k)/C(n, k)` (use `BigInt` or log-gamma to avoid overflow; return 1 when `n - c < k`), mean/median/p95 for cost, tokens, steps, latency, plus standard error for rates.
3. Outputs: `eval-report.json` (versioned schema, sorted keys, stable ordering), `eval-report.md` (table per variant and a failures section listing grader codes only), `junit.xml` (one testcase per `(task, variant)` with failure message = grader codes) for `PublishTestResults@2`.
4. Reports never include goals, transcripts, or content.
**Tests to write:** pass@k against hand-computed values (n=5,c=2,k=1..5, edge cases c=0, c=n); percentile computation; JSON schema validation of the report; Markdown golden test; JUnit validity (parse with an XML parser); determinism (same input same bytes).
**Acceptance Criteria:**

- [ ] pass@k matches reference values.
- [ ] Reports are deterministic and content-free.
- [ ] JUnit output loads in Azure test results.

---

## 16.8 CLI: `harness eval run`

**Parent:** #16 Eval runner
**Task Description:** Provide the one-line eval experience.
**Expected Inputs:** Suite path and flags.
**Expected Output:** `packages/cli/src/commands/eval.ts` (`run`), docs `docs/evals.md` CLI section.
**Dependencies:** none.
**Items it depends on:** 16.7, 20.2.
**Implementation guidance:**

1. `harness eval run <suite> [--model p/m[,p/m]] [--trials N] [--filter <tag|taskId>] [--isolation inprocess|docker] [--cassette record|replay|off] [--concurrency N] [--out <dir>] [--seed N] [--fail-under <rate>] [--max-cost-usd N] [--json]`.
2. `--model` creates one variant per model (a variant is `{ id, modelRoute, contextStrategy?, policyFile? }`; richer variants arrive via 16.9). Default `--trials` is the task's `trials` or 1; default isolation is `inprocess` with `--cassette replay`, and `docker` when `--cassette off`.
3. `--max-cost-usd` stops launching new trials when the cumulative cost exceeds the cap and marks remaining trials `skipped_budget`; the exit code is 6 in that case.
4. `--fail-under`: exit 1 if any selected `(task, variant)` pass rate is below the threshold.
5. Prints a concise summary table (pass rates, cost, steps) to stdout; writes full reports to `--out` (default `./eval-out/<timestamp>` using the injected clock).
**Tests to write:** CLI tests with a fake in-process suite: flag parsing, variant creation, filter selection, fail-under exit code, cost cap behavior, JSON mode output, output directory contents.
**Acceptance Criteria:**

- [ ] `harness eval run suite.ts --model a,b --trials 5` works end to end offline with cassettes.
- [ ] Cost caps stop spending and report skipped trials.
- [ ] Exit codes reflect pass-rate thresholds.

---

## 16.9 A/B comparison with sound statistics

**Parent:** #16 Eval runner
**Task Description:** Compare harness variants and models with confidence intervals and significance.
**Expected Inputs:** Two or more reports or a variants file.
**Expected Output:** `packages/eval/src/stats.ts`, `packages/eval/src/report/compare.ts`, CLI `harness eval compare a.json b.json` and `--variants variants.yaml` on `eval run`, `examples/evals/variants.yaml`.
**Dependencies:** none.
**Items it depends on:** 16.7, 16.8.
**Implementation guidance:**

1. Variants file: `variants: { id: Code, route?: ModelRef[], contextStrategy?: Code, policyFile?: string, configOverrides?: Record<string, JsonValue> }[]`; config overrides are validated through the config schema (20.1) so invalid overrides fail early.
2. Stats (no external deps, seeded PRNG): Fisher's exact test for pass-rate differences (two-sided, hypergeometric with `BigInt` or log-factorials); bootstrap 95 percent confidence interval for mean differences of cost, steps, and latency (2,000 resamples, seed from `--seed`); report effect size and label results `inconclusive` when either side has fewer than 10 trials.
3. `compare` output: per task and overall, table with metric, A, B, delta, CI, p-value, verdict (`better`, `worse`, `inconclusive`). Apply Holm-Bonferroni correction across tasks for the pass-rate test and show both raw and adjusted p-values.
4. Pairing: trials are matched by task and trial index when seeds are equal, but no paired test is assumed (document).
**Tests to write:** Fisher's exact against known contingency tables; bootstrap reproducibility with a fixed seed and coverage sanity on synthetic data; Holm correction table test; inconclusive labeling threshold; variants file validation.
**Acceptance Criteria:**

- [ ] Statistics match reference values within tolerance.
- [ ] Small samples are labeled inconclusive, not significant.
- [ ] Multiple-comparison correction applied and displayed.

---

## 16.10 Eval telemetry and the canary-leak grader

**Parent:** #16 Eval runner
**Task Description:** Emit traces for eval trials and verify privacy guarantees on every trial's artifacts.
**Expected Inputs:** Trial artifacts, task canaries.
**Expected Output:** attributes `harness.eval.suite` (code), `harness.eval.task` (code), `harness.eval.trial` (int) on the `harness.run` span (registry update), `packages/eval/src/canary.ts` (`scanForCanaries`, moved from `test/canary`), grader `no_canary_leak`.
**Dependencies:** none.
**Items it depends on:** 16.3, 8.5, 4.7.
**Implementation guidance:**

1. Add the three optional attributes to `harness.run` (via the registry; refresh the catalog and collector allowlist per 4.7/10.2). They are set only in eval mode.
2. Extract the canary scanning helpers from the 8.5 test harness into `packages/eval/src/canary.ts` and update 8.5 to import it (no duplication).
3. Grader `no_canary_leak`: after the trial, scan: the event DB bytes, vault DB bytes (must not contain plaintext), exported telemetry captured by the in-memory exporters (in-process) or the collector output file (docker), the workspace directory, and stdout/stderr logs; plant canaries according to the task (`canaries` array or generated per trial via the seeded PRNG and injected into the goal and fixtures).
4. Result codes: `canary_in_events`, `canary_in_vault_plaintext`, `canary_in_telemetry`, `canary_in_workspace_unexpected` (workspace may legitimately contain raw fixture data: the check only flags canaries that were not present in the original fixture), `canary_in_logs`.
5. Telemetry for evals goes to the in-memory pipeline only; never exported to external backends unless `--export-telemetry` is passed.
**Tests to write:** grader passes on a clean trial and fails on injected leaks (one per sink); fixtures containing canaries tolerated in the workspace; attribute presence on the run span in eval mode; 8.5 still passes after the refactor.
**Acceptance Criteria:**

- [ ] Every trial can assert zero leaks across all sinks.
- [ ] Eval attributes appear only in eval mode.
- [ ] Canary helpers are shared with the release gate.

---

## 16.11 Nightly Azure pipeline with cached cassettes and baselines

**Parent:** #16 Eval runner
**Task Description:** Schedule replay and live eval stages with secrets from Key Vault, cost caps, baselines, and artifacts.
**Expected Inputs:** Eval suites, cassettes, baseline report.
**Expected Output:** `azure-pipelines-nightly.yml`, `evals/baseline.json`, `harness eval baseline update`, `harness eval check-baseline`, docs `docs/evals-ci.md`.
**Dependencies:** Azure Key Vault service connection, `AzureKeyVault@2` task (verify), Microsoft-hosted agents.
**Items it depends on:** 16.8, 16.9, 12.4.
**Implementation guidance:**

1. Schedule: `schedules: - cron: "0 3 * * *"` with `branches.include: [main]` and `always: true`.
2. Stage `evals_replay`: `harness eval run evals/suites --cassette replay --isolation inprocess --out reports` (deterministic; also added to the PR `gates` stage when files under `evals/**` or cassette paths change). Publish JUnit and report artifacts.
3. Stage `evals_live` (nightly only): fetch secrets with `AzureKeyVault@2` into pipeline variables mapped to environment variables as secrets; run live with `--cassette record --isolation docker --max-cost-usd <cap>` (cap from a variable group); store newly recorded cassettes as a **build artifact** (never auto-committed).
4. Baseline: `evals/baseline.json` holds the last accepted `EvalReport` (aggregates only). `harness eval check-baseline <report> --max-drop 0.05` exits 1 if any `(task, variant)` pass rate drops by more than the threshold or any previously passing privacy assertion fails; `harness eval baseline update <report>` rewrites the file for a manual PR.
5. All logs and artifacts pass through the canary scan job (reuse 8.5) before publishing: a final step runs `scanForCanaries` over the artifact directory.
6. Pipeline YAML must not contain secrets; use variable groups and the Key Vault task only.
**Tests to write:** pipeline YAML structure test (schedule, stages, Key Vault step, artifact publishing, no literal secrets); unit tests for baseline comparison (drop within threshold passes, beyond fails, new task allowed, removed task flagged); `baseline update` determinism.
**Acceptance Criteria:**

- [ ] Nightly replay and live stages run on schedule with a cost cap.
- [ ] Pass-rate regressions beyond the threshold fail the pipeline.
- [ ] New cassettes are published as artifacts, not committed automatically.

---

## 16.12 Eval and replay report viewer MCP App

**Parent:** #16 Eval runner
**Task Description:** Let humans explore eval reports, A/B comparisons, and replay diffs as an MCP App in any MCP Apps host, using the content-free report data.
**Expected Inputs:** `EvalReport`, comparison output (16.9), `ReplayReport` (9.5).
**Expected Output:** control-plane tool `open_report { kind: "eval" | "compare" | "replay", path }` (scope `read`, paths restricted to configured report directories), view `packages/approval-app/src/views/reports/` built with the kit (5.7), resource `ui://harness/reports/v1` linked via `_meta.ui.resourceUri`, docs `docs/evals.md` section "Viewing reports".
**Dependencies:** `@modelcontextprotocol/ext-apps`.
**Items it depends on:** 16.9, 9.5, 18.1, 5.7.
**Implementation guidance:**

1. `open_report` reads the file with `parseJson` and the report's Zod schema, rejects paths outside `controlPlane.reportDirs` (path-safe resolution), and returns the parsed report (already content-free by construction).
2. Views: pass rates by task and variant with confidence intervals and pass@k; cost, steps, and latency distributions; failing grader and invariant codes; A/B tables with verdicts and adjusted p-values; replay diffs with behavioral and noise entries side by side.
3. Charts are drawn with inline SVG from the kit (no external libraries or URLs); every chart has a table alternative for accessibility.
4. Same security, accessibility, theming, and size checks as the other views.
**Tests to write:** path restriction (traversal, outside directories); rendering from fixture reports for each kind; chart and table parity; axe and XSS checks; size budget.
**Acceptance Criteria:**

- [ ] Eval, comparison, and replay reports can be explored in an MCP Apps host.
- [ ] Only files in configured report directories can be opened.
- [ ] Views meet the shared security and accessibility bar.
