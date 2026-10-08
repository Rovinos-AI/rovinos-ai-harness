# Epic #9: Replay (reproduce runs and diff traces)

**Goal:** reproduce a recorded run offline from its event log, and prove whether a harness change altered behavior, with noise-aware diffs and CI regression gates. Read `docs/engineering/CONVENTIONS.md` first, plus epics 2, 7, 14 (cassettes), and 17.
**Tasks:** 9.1 to 9.6, all size S.

Shared design for this epic:
- **What is compared.** Telemetry is metadata-only and not retained locally, so the comparable artifact is the **safe projection of events** (7.10) from the original log and from the replayed log, plus the logical step structure. This keeps diffs content-free and reproducible.
- **What replay serves.** Recorded model responses, tool results, and human decisions come from the original event log (cassette ports). Replay never calls a real model, tool, or human.
- **Replay is for testing harness changes.** The current code runs against recorded inputs; config drift (different policy or context strategy) is reported, not hidden.
- Package `packages/replay`; CLI `harness replay`. Determinism comes from replay ports (ids, clock, responses), not from real randomness.

---

## 9.1 Resolve a run from a trace id or run id

**Parent:** #9 Replay
**Task Description:** Find the run (and related subagent runs) to replay and load its events.
**Expected Inputs:** `--run <Id>` or `--trace <32-hex traceId | traceparent string>`.
**Expected Output:** `packages/replay/src/resolve.ts` (`resolveRun`), `packages/cli/src/commands/replay.ts` (argument parsing skeleton), package scaffold `packages/replay`.
**Dependencies:** none.
**Items it depends on:** 7.7, 2.10, 20.2.
**Implementation guidance:**
1. `resolveRun({ store, runId?, traceId? }): Promise<ResolvedRun>` with `ResolvedRun = { rootRunId, runs: { runId, role: "root"|"subagent", parentRunId?, events: Event[] }[] }`.
2. Trace input: accept a bare trace id or a W3C `traceparent` (parse and validate); call `store.findRunsByTrace`. If several runs match, choose the one whose `run_created` has no `parentRunId` as root and attach the others as subagents; if there is no single root, throw `trace_ambiguous` listing run ids.
3. Load events with `store.read`; cap at 1,000,000 events (`replay_too_large`). Verify `seq` is contiguous from 0 (`corrupt_log` otherwise) and that the run's first event is `run_created`.
4. Missing runs throw `run_not_found`. Never print event content.
5. CLI: `harness replay (--run <id> | --trace <id>) [--strict] [--golden <file>] [--update-baseline] [--report <path>] [--json]`; this task wires parsing and calls `resolveRun`, printing the resolved run ids (metadata) until later tasks add execution.
**Tests to write:** resolve by run id; resolve by trace id and by `traceparent`; parent and subagent grouping; ambiguous trace; unknown ids; corrupt log detection; size cap; CLI parsing table.
**Acceptance Criteria:**
- [ ] A trace or run id resolves to a complete, validated event list.
- [ ] Ambiguity and corruption produce typed errors.
- [ ] No content printed.

---

## 9.2 Replay ports: serve recorded model, tool, and human responses

**Parent:** #9 Replay
**Task Description:** Build the deterministic ports that make the run loop re-execute from recorded data.
**Expected Inputs:** Resolved events.
**Expected Output:** `packages/replay/src/ports/{replay-model.ts,replay-tools.ts,replay-human.ts,replay-ids.ts,replay-clock.ts}`, `buildReplayRuntime(resolved, config)`.
**Dependencies:** none.
**Items it depends on:** 9.1, 14.15, 2.9.
**Implementation guidance:**
1. **Model:** `EventLogCassetteStore` (14.15) wrapped by `CassetteProvider` in replay mode, registered as provider `cassette`; routing for the replay run maps every role to it. Each recorded `model_request`/`model_response` pair is served in order and the request hash is verified (divergence error `replay_divergence` carries the seq and a hash mismatch code only).
2. **Tools:** `ReplayToolPort` implements `ToolPort`. `describe` uses recorded `tool_intent.idempotent` and timeouts from the current registry if available; `execute(call)` looks up the recorded `tool_result` by `callId` and returns it (outcome, result, errorCode). If the recorded args hash differs from the call's args, throw `replay_divergence`; if no result exists (the original run was interrupted), throw `replay_missing_result`.
3. **Human:** `ReplayHuman` resolves approvals from recorded `approval_resolved` events matched by `callId` (decision, edits) through the normal `resolveApproval` and `resumeRun` path.
4. **Ids and time:** `ReplayIdGenerator` yields ids in the order they appear in the recorded log (requestIds, callIds already come from provider results; approvalIds, checkpointIds, segmentIds from log events); running out of recorded ids falls back to a deterministic seeded generator and records `replay_ids_exhausted` in the report. `ReplayClock` advances from the first recorded `ts` by 1 ms per call (timestamps are normalized out in diffs).
5. The replay runtime uses a **fresh temporary store and vault** (never the original), with PII tokenization disabled for ports that already return tokenized recorded content (flag `alreadyTokenized: true`; the storage-boundary decorator stays on).
**Tests to write:** each port against a fixture log (served in order); hash mismatch divergence; missing result; approvals replayed through `resolveApproval`; id generator ordering and exhaustion fallback; replay runtime never touches the original store (spy).
**Acceptance Criteria:**
- [ ] Replay never calls a real model, tool, or human.
- [ ] Divergence from the recording is detected and typed.
- [ ] The original store and vault are never modified.

---

## 9.3 Re-execute and emit a linked trace

**Parent:** #9 Replay
**Task Description:** Run the loop on the replay ports, producing a new run whose trace links to the original.
**Expected Inputs:** `ResolvedRun`, current config.
**Expected Output:** `packages/replay/src/replay.ts` (`replayRun`), span definition `harness.replay`, schema change adding `replayOf?: Id` (meta) to `run_created`, `ReplayOutcome`.
**Dependencies:** none.
**Items it depends on:** 9.2, 7.1, 4.1.
**Implementation guidance:**
1. Schema: add `replayOf?: Id` to `run_created` (meta), classification, SafeEvent `run_created` mapping, and goldens.
2. `replayRun(resolved, options)`: build the replay runtime (9.2), start a root `harness.replay` span with a **span link** to the original run's trace context (reconstructed from the first event's `traceId` and `spanId`), create a new run with `run_created.replayOf = originalRunId`, input copied from the recorded `run_input`, then run the loop to completion, handling suspensions with `ReplayHuman` until terminal.
3. Compare `configHash` and `policyVersion` with the original `run_created`; set `configDrift` and `policyDrift` flags in the outcome (expected when testing changes).
4. Result: `ReplayOutcome = { replayRunId, traceId, status, events, configDrift, policyDrift, divergence?: { seq, code } }`; a thrown `replay_divergence` or `replay_missing_result` is captured into `divergence` and the outcome status `error`.
5. Subagent runs (23.x) replay recursively using their own recorded logs when present.
**Tests to write:** replay of a simple run yields the same status and event kinds; link present on the replay span (spy exporter); `replayOf` set; config and policy drift flags; divergence captured not thrown; suspended-and-approved scenario completes.
**Acceptance Criteria:**
- [ ] Replay trace is linked to the original and marked via `replayOf`.
- [ ] Drift is reported explicitly.
- [ ] Divergence surfaces as data, not an unhandled crash.

---

## 9.4 Normalized diff of runs

**Parent:** #9 Replay
**Task Description:** Compare original and replay logs structurally, ignoring expected noise and classifying differences.
**Expected Inputs:** Two event lists.
**Expected Output:** `packages/replay/src/diff.ts` (`normalizeRun`, `diffRuns`), `DiffEntry` types.
**Dependencies:** none.
**Items it depends on:** 9.3, 7.10.
**Implementation guidance:**
1. `normalizeRun(events): NormalizedEvent[]`: project each event with `toSafeEvent` (events with `null` safe mapping are represented by `{ kind: "<type>" }` only), drop `runId`, `seq`, `ts`, `traceId`, `spanId`, `segmentId`, `policyVersion`; replace every id-valued field (`callId`, `approvalId`, `requestId`, `checkpointId`, `childRunId`) with order-of-first-appearance aliases (`call#1`, `call#2`, ...).
2. Noise classes: **ignored by default** `latencyMs`, `waitMs`, `costMicros`, `repairAttempts` only when `--ignore-metrics` is set; otherwise latency and wait are ignored and everything else is compared. Provide `options.ignoreFields: Code[]` and `options.compareTokens: boolean` (default true).
3. `diffRuns(a, b, options): { identical: boolean; summary: { added, removed, changed, behavioral, noise }; entries: DiffEntry[] }` using an LCS over a stable string signature of each normalized event (cap 5,000 events per side; beyond that fall back to a positional diff and set `approximate: true`).
4. `DiffEntry = { kind: "added" | "removed" | "changed", index: number, eventKind: Code, fields?: { field: Code, a: string|number|boolean, b: string|number|boolean }[], class: "behavioral" | "noise" }`. Behavioral changes include tool ids, outcomes, status transitions, step counts, errors, approval decisions, policy decisions; noise includes ignored metrics. Values in `fields` are meta values only (enums, ints, codes).
5. Never include content-classified fields.
**Tests to write:** identical runs; id renaming makes runs with different ULIDs equal; added/removed/changed cases; LCS alignment with an inserted event; noise vs behavioral classification table; large-run fallback flagged `approximate`; property test with canary content: entries never contain canaries.
**Acceptance Criteria:**
- [ ] Runs differing only in ids and timestamps diff as identical.
- [ ] Behavioral changes are separated from noise.
- [ ] Diff output contains meta values only.

---

## 9.5 Reports, exit codes, and baseline updates

**Parent:** #9 Replay
**Task Description:** Produce machine- and human-readable replay reports and CI-friendly exit codes, with a safe way to accept intentional changes.
**Expected Inputs:** `ReplayOutcome`, `DiffResult`, golden signature file.
**Expected Output:** `packages/replay/src/report.ts` (`ReplayReport` schema, JSON and text renderers), CLI flags `--strict`, `--golden`, `--update-baseline`, `--report`.
**Dependencies:** none.
**Items it depends on:** 9.4.
**Implementation guidance:**
1. `ReplayReport = { schemaVersion: 1, originalRunId, replayRunId, status, configDrift, policyDrift, approximate, summary, entries, divergence?: { seq, code }, goldenMatch?: boolean }`, JSON with sorted keys; text renderer prints a summary and the first 50 entries. `ReplayReport` and the golden signature file (step 3) are Zod schemas; readers use `parseJson` (CONVENTIONS 3.10).
2. Exit codes: `0` identical or noise-only (when not `--strict`), `1` behavioral differences (or any difference with `--strict`), `2` usage, `8` replay failure (divergence, missing result, corrupt log).
3. `--golden <file>`: instead of comparing with a live original, compare the replay's normalized signature to a committed golden signature file `{ schemaVersion, containsRealData: false, signature: NormalizedEvent[] }`.
4. `--update-baseline` (requires `--golden`): rewrites the golden file **only if the replay completed without divergence**; prints a diff summary; refuses (exit 2) when `CI=1` unless `--force-in-ci` is passed, and never runs in the Azure `gates` stage by default.
5. Reports never contain content (meta fields only), validated by a schema and a canary property test.
**Tests to write:** report schema validation; exit code table; golden compare pass and fail; update-baseline success and refusal cases (divergence, CI guard); determinism (same inputs same bytes).
**Acceptance Criteria:**
- [ ] CI can gate on exit codes with clear semantics.
- [ ] Baseline updates are explicit and refused in CI by default.
- [ ] Reports are content-free and deterministic.

---

## 9.6 Golden-run fixture and the regression gate

**Parent:** #9 Replay
**Task Description:** Commit a representative golden run and wire replay regression tests into the `gates` stage.
**Expected Inputs:** Scripted scenario using fake providers and tools.
**Expected Output:** `test/replay/golden/` (cassette, signature file, scenario script), `test/replay/golden.replay.test.ts`, `scripts/replay-golden.ts` (`record` and `update`), `yarn test:replay` and `yarn replay:update`, PR-template checkbox, docs `docs/replay-regression.md`.
**Dependencies:** none.
**Items it depends on:** 9.5, 2.11, 15.5, 17.3.
**Implementation guidance:**
1. Scenario script (fake model script and fake tools) covering: a model call with tool calls (idempotent and non-idempotent tools), a policy `ask` approval with an edit, a checkpoint, a context compaction, a crash-and-resume segment, a `deny` result, and a final answer. All data synthetic; mark `containsRealData: false`.
2. `scripts/replay-golden.ts record` runs the scenario with the real runtime, writes the cassette (via `FileCassetteStore`) and the golden signature; `update` re-records after a deliberate change.
3. `golden.replay.test.ts`: load the cassette, replay with current code, assert exit-code-0 semantics (empty behavioral diff) and that the replay completes without divergence.
4. **Mutation check:** a second test injects a deliberate behavior change through a test-only hook (for example swapping tool execution order or altering a policy default) and asserts the replay reports a behavioral difference (exit code 1), proving the gate can fail.
5. Azure: `yarn test:replay` runs in the `gates` stage and blocks merges. Add a PR-template checkbox: "If this PR changes agent behavior, I regenerated the golden run with `yarn replay:update` and explained why in the PR description."
**Tests to write:** the golden replay test and the mutation test above; a test that the golden files declare synthetic data and contain no canary patterns.
**Acceptance Criteria:**
- [ ] Any harness change that alters recorded behavior fails the PR gate.
- [ ] The mutation check proves the gate can fail.
- [ ] Golden data is synthetic and documented.
