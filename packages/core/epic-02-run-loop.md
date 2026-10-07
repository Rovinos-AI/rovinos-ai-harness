# Epic #2: Run loop (resumable state machine)

**Goal:** the resumable, crash-safe core that turns model calls and tool calls into an append-only event log. Read `docs/engineering/CONVENTIONS.md` first.
**Tasks:** 2.1 to 2.14, all size S.

Shared design for this epic:
- **Ports, not packages.** `core` depends on small interfaces defined in `packages/core/src/ports.ts`: `ModelPort`, `ToolPort`, `ContextPort`, `PolicyPort`, `Clock`, `IdGenerator`, `EventStore`. Real implementations arrive in other epics (models 14, context 15, policy 17, mcp 6, sandbox 19). Fakes live in `packages/core/src/testing/` and are the only implementations used in this epic.
- **Durability rule:** a side effect (tool execution) is never started before its `tool_intent` event is durably appended. A tool result is never assumed until `tool_result` is appended.
- **Lease by conflict:** a worker "owns" a run only as long as its appends succeed. A `seq_conflict` means another worker or a cancel acted; the loop must stop and inspect, never retry blindly.
- **Segments:** each (re)start of a run gets a new `segmentId` and a new root span linked to the previous segment.

---

## 2.1 State machine transition table as pure functions

**Parent:** #2 Run loop
**Task Description:** Define run statuses, triggers, and a pure transition function plus a pure fold that derives run state from events.
**Expected Inputs:** `RunStatus` (7.1), `Event[]`.
**Expected Output:** `packages/core/src/state-machine.ts` (`transition`, `canTransition`), `packages/core/src/run-state.ts` (`foldRunState`, `RunState`), package scaffold `packages/core`.
**Dependencies:** none.
**Items it depends on:** 7.1.
**Implementation guidance:**
1. Triggers: `start`, `request_approval`, `approval_resolved`, `complete`, `fail`, `cancel`, `shutdown`, `resume`. Table: `pending --start--> running`; `running --request_approval|shutdown--> suspended`; `running --complete--> completed`; `running --fail--> failed`; `running --cancel--> cancelled`; `suspended --resume--> running`; `suspended --cancel--> cancelled`; `suspended --fail--> failed`. Terminal states (`completed`, `failed`, `cancelled`) accept nothing. Everything else returns `{ ok: false, code: "invalid_transition" }`.
2. `transition(from, trigger): { ok: true; to: RunStatus } | { ok: false; code: Code }` is total and side-effect free.
3. `RunState = { status, nextSeq, steps (count of model_response), usage { inputTokens, outputTokens, costMicros }, pendingToolCalls: Map<callId, ToolIntentEvent>, pendingApprovals: Map<approvalId, ApprovalRequestedEvent>, lastCheckpoint?: {checkpointId, atSeq}, segmentId, startedAt, lastTs }`.
4. `foldRunState(events: Iterable<Event>): RunState` applies events in order: `tool_intent` adds to pending, `tool_result` removes it; `approval_requested` adds, `approval_resolved` removes; `run_status_changed` sets status after verifying it is a legal transition (else throw `corrupt_log`); `model_response` increments `steps` and usage.
5. Keep both functions free of I/O and clocks.
**Tests to write:** table-driven transition tests for every (state, trigger) pair; fold tests: pending intent removed by result; approval lifecycle; illegal status sequence throws `corrupt_log`; fold is deterministic (same events, same state); property test generating random legal event sequences never throws.
**Acceptance Criteria:**
- [ ] Every (state, trigger) pair has a tested outcome.
- [ ] Terminal states are absorbing.
- [ ] `foldRunState` has no side effects and rejects corrupt logs.

---

## 2.2 Typed events and registered spans per step

**Parent:** #2 Run loop
**Task Description:** Create the `RunRecorder` that is the single place where events are built, sequenced, appended, and paired with spans.
**Expected Inputs:** `EventStore`, `Clock`, `IdGenerator`, current span context, `RunState`.
**Expected Output:** `packages/core/src/recorder.ts` (`RunRecorder`), span definitions in `packages/core/src/spans.ts`.
**Dependencies:** `@opentelemetry/api`.
**Items it depends on:** 2.1, 7.2, 4.1.
**Implementation guidance:**
1. Spans (all via `defineSpan`, 4.1): `harness.run` (root per segment; attrs `harness.run.id`, `harness.segment.id`), `harness.model_call`, `harness.tool_call`, `harness.approval_wait`, `harness.checkpoint`, `harness.compaction`. Each carries `harness.run.id` and `harness.event.seq`.
2. `RunRecorder(store, runId, segmentId, startSeq, clock)` keeps `nextSeq`. `record(partial: Omit<NewEvent,"runId"|"ts"|"traceId"|"spanId"|"segmentId">): Promise<Event>` fills envelope fields (`ts` from the clock, `traceId`/`spanId` from the active span, `segmentId`), appends with `expectedSeq = nextSeq`, increments `nextSeq` on success. On `SeqConflictError` it throws `LeaseLostError` (`lease_lost`) carrying the stored head.
3. `recordBatch(partials)` appends several events atomically (used for status change plus checkpoint).
4. `withStepSpan(def, attrs, fn)` starts a span through the registry, injects the eventual `seq` after `record` returns (set attribute then end span in `finally`).
5. Never create events outside the recorder (lint note in header; enforced by review).
**Tests to write:** envelope fields filled deterministically with fakes; seq increments across calls; conflict surfaces as `lease_lost`; batch is atomic; span attributes contain only registry-allowed fields (spy exporter); `harness.event.seq` equals the stored seq.
**Acceptance Criteria:**
- [ ] All run-loop events go through `RunRecorder`.
- [ ] Each step span carries `harness.run.id` and `harness.event.seq`.
- [ ] Conflict yields `lease_lost` and no further appends.

---

## 2.3 Model-call step with a fake provider (walking skeleton)

**Parent:** #2 Run loop
**Task Description:** Implement the loop driver and the model step against ports, terminating when the model returns a final answer. This is the first end-to-end run.
**Expected Inputs:** `ModelPort`, `ContextPort`, `RunRecorder`, goal input.
**Expected Output:** `packages/core/src/ports.ts`, `packages/core/src/loop.ts` (`runLoop`), `packages/core/src/steps/model-step.ts`, `packages/core/src/testing/{fake-model.ts,naive-context.ts}`.
**Dependencies:** none.
**Items it depends on:** 2.1, 2.2.
**Implementation guidance:**
1. `ModelPort.complete(req: { requestId: Id; messages: JsonValue; role?: Code }, ctx: { runId: Id; signal: AbortSignal }): Promise<{ content: JsonValue; toolCalls: {callId: Id; toolId: Code; args: JsonValue}[]; usage: {inputTokens:number; outputTokens:number; costMicros?: number}; finishReason: Code; provider: Code; model: Code; latencyMs: number; schemaValid: boolean; repairAttempts: number; providerBlobs: JsonValue }>`. The gateway (14.x) will implement it; keep it provider-agnostic.
2. `ContextPort.build(events: readonly Event[]): Promise<JsonValue>` returns the messages to send. `NaiveContext` returns all `model_response.content` and tool results in order (replaced in epic 15).
3. Model step: record `model_request` (before the call), call the port inside `harness.model_call`, record `model_response` with all meta fields. On port error record `tool`-style failure as `run_status_changed running->failed` with reason from the error `code`.
4. `runLoop`: on entry record `run_created` (new runs) then `run_status_changed pending->running`; loop: build context -> model step -> if `toolCalls` is empty complete (`running->completed`, reason `final_answer`) else (tool handling arrives in 2.4) fail with reason `tools_not_supported` for now.
5. `FakeModelPort` takes a script array of responses and records requests for assertions.
**Tests to write:** one-step run completes with the expected event sequence (golden file `__golden__/one-step.json`); model error produces `failed`; requests captured contain the built context; usage totals folded correctly.
**Acceptance Criteria:**
- [ ] A scripted run produces `run_created, status(running), model_request, model_response, status(completed)`.
- [ ] No store write happens outside the recorder.
- [ ] Golden test passes deterministically.

---

## 2.4 Tool-call step with two-phase intent and result logging

**Parent:** #2 Run loop
**Task Description:** Execute tool calls with the durability rule: intent appended before execution, result appended after.
**Expected Inputs:** `ToolPort`, tool calls from the model response.
**Expected Output:** `packages/core/src/steps/tool-step.ts`, `ToolPort` in `ports.ts`, `FakeToolPort` in testing, loop updated to continue after tools.
**Dependencies:** none.
**Items it depends on:** 2.3.
**Implementation guidance:**
1. `ToolPort.describe(toolId): { idempotent: boolean; timeoutMs: number } | undefined`; `ToolPort.execute(call: { callId; toolId; args: JsonValue }, ctx: { runId; signal }): Promise<{ outcome: "ok"|"error"; result: JsonValue; errorCode?: Code }>`.
2. For each call, in order: validate `toolId` is known (else record `tool_intent` with `policyDecision: "deny"` and a `tool_result` outcome `denied`, errorCode `unknown_tool`, no execution). Record `tool_intent {callId, toolId, idempotent, policyDecision: "allow", args}` and **wait for the append to resolve** before calling `execute`.
3. Wrap `execute` with an `AbortSignal.timeout(timeoutMs)`; on timeout record `tool_result` outcome `timeout`, errorCode `tool_timeout`. Exceptions map to outcome `error` with `errorCode` from `HarnessError.code` or `tool_failed`.
4. Record `tool_result` with `latencyMs` measured by the injected clock.
5. Tool results are fed back through `ContextPort`. Parallel tool calls are sequential in this task (note as future work).
6. The policy decision is a constant `allow` until task 17.3 replaces it with `PolicyPort`.
**Tests to write:** event order `tool_intent` before `execute` call (assert via fake that checks store contents at call time); timeout; error mapping; unknown tool denied without execution; result fed into next model request.
**Acceptance Criteria:**
- [ ] A fake tool's `execute` observes that its `tool_intent` is already durable.
- [ ] Timeout and error paths produce well-formed `tool_result` events.
- [ ] Multi-step runs (model, tool, model, final) complete.

---

## 2.5 Idempotency declaration and resume policy

**Parent:** #2 Run loop
**Task Description:** Decide what to do on resume with a `tool_intent` that has no `tool_result`: re-run idempotent tools, escalate non-idempotent ones.
**Expected Inputs:** `RunState.pendingToolCalls`, tool metadata, policy config `onNonIdempotent`.
**Expected Output:** `packages/core/src/resume-policy.ts` (`planDanglingIntents`), config fragment field `run.resume.onNonIdempotent`, handling helpers in `tool-step.ts`.
**Dependencies:** none.
**Items it depends on:** 2.1, 2.4, 20.1.
**Implementation guidance:**
1. `planDanglingIntents(state, toolPort, policy): Action[]` pure function returning per call: `{ kind: "rerun", callId }` if `describe(toolId).idempotent`, else `{ kind: "escalate", callId }` (or `{ kind: "fail", callId, errorCode: "resume_ambiguous" }` when `onNonIdempotent === "fail"`). Unknown tools produce `fail` with `unknown_tool`.
2. `rerun`: execute again using the same `callId` and **do not** append a second `tool_intent`; append only the `tool_result`.
3. `escalate`: append `approval_requested` with `payload { kind: "resume_ambiguity", callId, toolId }` (content), suspend the run (see 2.9). Resolution `approve` means re-run once; `deny` means append `tool_result` outcome `error`, errorCode `resume_ambiguous`.
4. `fail`: append `tool_result` outcome `error`, errorCode `resume_ambiguous`, continue the loop so the model can react.
5. Default policy: `escalate`.
**Tests to write:** table tests for the planner (idempotent, non-idempotent, unknown tool, both policies); integration with fakes: idempotent tool re-run exactly once, non-idempotent tool not executed until approved.
**Acceptance Criteria:**
- [ ] Non-idempotent dangling intents never execute without a decision.
- [ ] Idempotent ones re-run exactly once and reuse the `callId`.
- [ ] Default and override behavior tested.

---

## 2.6 Checkpoint write including traceparent

**Parent:** #2 Run loop
**Task Description:** Write checkpoints (event plus snapshot) on a cadence, before suspension, and on demand.
**Expected Inputs:** `RunState`, `ContextPort.snapshot()`, active span context, `EventStore.appendWithSnapshot`.
**Expected Output:** `packages/core/src/checkpoint.ts` (`Checkpointer`), `ContextPort.snapshot(): Promise<JsonValue>` addition, config `run.checkpointEveryEvents` (default 20).
**Dependencies:** none.
**Items it depends on:** 2.2, 7.8.
**Implementation guidance:**
1. `Checkpointer.write(state, reason: Code)`: build `Snapshot { snapshotId: new Id, runId, atSeq: recorder.nextSeq (the seq of the checkpoint event itself), createdAt, traceparent, context: await context.snapshot(), plan: state.plan ?? null, workspaceRef: undefined }` (workspace snapshots arrive in 19.6).
2. `traceparent` is `00-${traceId}-${spanId}-01` from the active span context; throw `no_active_span` if invalid.
3. Use `appendWithSnapshot` with a single `checkpoint_written` event (`checkpointId = snapshotId`, `atSeq`).
4. `maybeCheckpoint(state)` is called after each step; checkpoint when `events since last checkpoint >= checkpointEveryEvents`. Always checkpoint before returning `suspended`.
5. Checkpoint spans use `harness.checkpoint`.
**Tests to write:** cadence boundaries with a fake store; traceparent format valid; snapshot and event atomic (inject conflict: neither written); suspension forces a checkpoint; `atSeq` equals the checkpoint event's seq.
**Acceptance Criteria:**
- [ ] Checkpoints written on cadence and before suspension.
- [ ] Persisted `traceparent` parses and matches the checkpoint span.
- [ ] Failure leaves neither event nor snapshot.

---

## 2.7 Resume from the last checkpoint

**Parent:** #2 Run loop
**Task Description:** Resume an interrupted or suspended run: claim it by conflict, rebuild state, link traces, resolve dangling intents, continue.
**Expected Inputs:** `runId`, ports, store.
**Expected Output:** `packages/core/src/resume.ts` (`resumeRun`), `LeaseLostError` handling, new segment id.
**Dependencies:** none.
**Items it depends on:** 2.5, 2.6, 2.9.
**Implementation guidance:**
1. Read all events (or from the latest snapshot's `atSeq` when available) and `foldRunState`. If status is terminal throw `run_already_terminal`.
2. Claim the run: append `run_status_changed` (`from` current, `to: running`, `reason: resumed`) with `expectedSeq = head`. A conflict means someone else resumed, so throw `resume_conflict` and do nothing else. When the status is already `running` (interrupted worker), the claim event is `run_status_changed running->running` is illegal, so instead append a `run_status_changed running->suspended reason interrupted` followed by `suspended->running reason resumed` in one batch (`recordBatch`).
3. New `segmentId`; start a root `harness.run` span with a **span link** to the checkpoint's `traceparent` (or the last event's `traceId`/`spanId` if no checkpoint).
4. Rebuild context: `ContextPort.restore(snapshot.context, eventsAfterSnapshot)` (extend the port).
5. Apply `planDanglingIntents` actions (2.5), then pending approvals: if an approval is still unresolved, immediately re-suspend; if resolved, apply the decision.
6. Continue with `runLoop` from the rebuilt state.
**Tests to write:** resume after crash mid-model-step; resume with dangling idempotent and non-idempotent intents; two concurrent resumers: exactly one wins; resume of terminal run rejected; new segment id and span link present (spy exporter).
**Acceptance Criteria:**
- [ ] Exactly one of two concurrent resumers proceeds.
- [ ] The resumed trace has a link to the prior segment.
- [ ] Dangling intents handled per 2.5.

---

## 2.8 SIGTERM handler flushing a checkpoint

**Parent:** #2 Run loop
**Task Description:** On SIGTERM/SIGINT, stop gracefully: abort in-flight work, reach a safe point, suspend with a checkpoint, exit.
**Expected Inputs:** Process signals, run controller, grace period `run.shutdownGraceMs` (default 20000).
**Expected Output:** `packages/core/src/shutdown.ts` (`installShutdownHandler`), integration in `runLoop`.
**Dependencies:** none.
**Items it depends on:** 2.6, 2.7.
**Implementation guidance:**
1. `installShutdownHandler({ processLike, controller, graceMs, onTimeout })` listens for SIGTERM/SIGINT once, calls `controller.abort(reason "shutdown")`, and returns an uninstall function. `processLike` is injected for tests.
2. The loop checks `signal.aborted` between steps. In-flight tool execution receives the signal; a tool aborted mid-flight leaves a dangling intent (handled on resume by 2.5).
3. At a safe point: record `run_status_changed running->suspended reason shutdown`, write a checkpoint (2.6), exit code 143 (SIGTERM) or 130 (SIGINT).
4. If the grace period expires first, force exit with code 1 after attempting a best-effort checkpoint; record `shutdown_timeout` via logger.
5. Containers must use `STOPSIGNAL SIGTERM` and `stop_grace_period` greater than `graceMs` (add to compose in 19.8).
**Tests to write:** fake process emitter: signal during a model step results in suspended status, checkpoint, correct exit code; signal during a tool step leaves a dangling intent; grace timeout path; double signal ignored.
**Acceptance Criteria:**
- [ ] Graceful stop leaves a resumable run (resume completes it).
- [ ] Grace timeout path tested.
- [ ] Handler installs once and is removable.

---

## 2.9 Suspended state for approvals

**Parent:** #2 Run loop
**Task Description:** Implement the approval lifecycle at the log level: request, suspend, resolve (without needing the original process), and apply on resume.
**Expected Inputs:** Approval request payloads, decisions.
**Expected Output:** `packages/core/src/approvals.ts` (`requestApproval`, `resolveApproval`, `applyResolvedApprovals`), loop suspension path.
**Dependencies:** none.
**Items it depends on:** 2.1, 2.6.
**Implementation guidance:**
1. `requestApproval(recorder, { callId, payload, expiresAt? })` records `approval_requested`, then `run_status_changed running->suspended reason awaiting_approval`, then writes a checkpoint, then the loop returns `{ status: "suspended", approvalIds }`.
2. `resolveApproval(store, runId, approvalId, decision, edits?)` is a standalone function (no running process): read head, verify the approval is pending (else `approval_not_found` or `approval_already_resolved`), append `approval_resolved {decision, waitMs, edits?}` with `expectedSeq = head`. It does not change run status.
3. `applyResolvedApprovals(state)` is used by resume: `approve` executes the tool call with original args; `edit` executes with `edits` replacing args (validate against the tool's input schema in 6.x/17.x; here pass through); `deny` records `tool_result` outcome `denied`.
4. `waitMs = resolvedAt - requestedAt` using the event timestamps.
5. An approval is for exactly one `callId`; multiple approvals may be pending.
6. Hashes for audit: `tool_intent.argsHash` is the SHA-256 of the canonical JSON of the recorded (tokenized) args. When an `edit` decision changes the args, the `tool_result` records `executedArgsHash` for the edited, tokenized args, so the edit-integrity invariant (22.6) can verify that only editable pointers changed.
**Tests to write:** request suspends and checkpoints; resolve from a different process instance (new store connection) then resume proceeds; double resolve rejected; deny path; edit path passes edited args; `waitMs` computed from fake clock; `argsHash` and `executedArgsHash` recorded and consistent with the canonical args.
**Acceptance Criteria:**
- [ ] A run suspended for approval can be resolved and resumed after the original process exited.
- [ ] Double resolution rejected.
- [ ] Decisions (approve, deny, edit) each tested end-to-end.

---

## 2.10 CLI: `harness run | resume | inspect`

**Parent:** #2 Run loop
**Task Description:** Expose the run loop through the CLI and add the composition root that builds a runtime from config.
**Expected Inputs:** Config, task input, run id.
**Expected Output:** `packages/core/src/runtime.ts` (`createRuntime(config, overrides)`), `packages/cli/src/commands/{run,resume,inspect}.ts`, `docs/cli.md` sections.
**Dependencies:** none.
**Items it depends on:** 2.7, 2.8, 2.9, 20.2, 7.3.
**Implementation guidance:**
1. `harness run --input <json-file|-> [--fake-model <script.json>]`: input schema `{ goal: string, metadata?: Record<Code, Code|number|boolean> }`; prints the `runId` (JSON mode: `{ runId, status }`); exit code 0 completed, 5 suspended, 1 failed, 6 budget exceeded.
2. `harness resume <runId>`: calls `resumeRun`; same exit codes.
3. `harness inspect <runId> [--show-content]`: prints status, steps, usage, last checkpoint, pending approvals (ids and tool ids), and the last 10 events as safe summaries (`toSafeEvent` when available, otherwise type and seq). `--show-content` prints stored (tokenized) content; warn on stderr that content may be sensitive.
4. `createRuntime` wires the store from config (SQLite default at `<dataDir>/harness.db`), `Clock`, `IdGenerator`, signal handler, and ports; `overrides` lets tests inject fakes. Real model/tool/context/policy wiring is added by 14.13, 6.x, 15.x, 17.3.
**Tests to write:** CLI integration tests with fake ports: run completes with exit 0; run suspending returns exit 5 and `inspect` shows the pending approval; `resume` after resolving completes; `--json` output shapes; inspect hides content by default.
**Acceptance Criteria:**
- [ ] The three commands work end to end against a fake model.
- [ ] Exit codes match `docs/cli.md`.
- [ ] `inspect` shows no content unless `--show-content`.

---

## 2.11 Crash-injection harness

**Parent:** #2 Run loop
**Task Description:** Build a test utility that kills a run at every append boundary and proves resume yields the same result without duplicate non-idempotent effects.
**Expected Inputs:** A scripted scenario (fake model script, fake tools with counters).
**Expected Output:** `packages/core/src/testing/crash-store.ts` (`CrashingEventStore`), `test/crash-injection.int.test.ts` (runs in integration stage using SQLite file store).
**Dependencies:** none.
**Items it depends on:** 2.7, 2.10.
**Implementation guidance:**
1. `CrashingEventStore(inner, { crashAt: number, mode: "before_commit" | "after_commit" })` counts `append`/`appendWithSnapshot` calls; at call number `crashAt` it either throws `SimulatedCrash` before delegating (`before_commit`) or delegates then throws (`after_commit`, simulating a lost acknowledgement).
2. Discovery run: execute the scenario with no crash to count total appends `N` and capture the reference log (normalized: strip `ts`, `segmentId`, `spanId`, `traceId`).
3. For each `k in 1..N` and each mode: fresh DB; run until `SimulatedCrash`; discard all in-memory state (new runtime instance); call `resumeRun`; run to completion.
4. Assert: final status equals the reference; normalized event types after normalization of resume bookkeeping events (`run_status_changed` reasons `interrupted|resumed`, extra checkpoints) match the reference's semantic sequence (compare only `model_response`, `tool_result` content and order); every non-idempotent fake tool's counter is exactly 1; idempotent tools' counter is at most 2.
5. For `after_commit` crashes the process believes the append failed; the harness must tolerate that the event exists (resume reads the log, not memory).
**Tests to write:** The scenario matrix itself: model, non-idempotent tool, idempotent tool, approval suspension, checkpoint. Include a deliberately broken variant (execute before intent append) proving the harness detects a violation.
**Acceptance Criteria:**
- [ ] All crash points pass in both modes.
- [ ] Non-idempotent tool executes exactly once at every crash point.
- [ ] The broken variant fails the suite.

---

## 2.12 Run budgets and stop conditions

**Parent:** #2 Run loop
**Task Description:** Enforce step, cost, and wall-clock budgets, ending the run with a `budget_exceeded` event.
**Expected Inputs:** Config `run.budgets`, `RunState.usage`, clock.
**Expected Output:** `packages/core/src/budgets.ts` (`BudgetTracker`), schema change adding optional `costMicros` (meta int) to `model_response`, loop integration, exit code 6 mapping.
**Dependencies:** none.
**Items it depends on:** 2.3, 2.4, 20.1.
**Implementation guidance:**
1. `BudgetTracker.check(state, now): { ok: true } | { ok: false; budget: "steps"|"cost"|"wall_clock"; limit; observed }` pure; called before each model call and each tool call.
2. Wall clock measured from `run_created.ts`, so it survives resume (document that suspended time counts; add `run.budgets.countSuspendedTime: false` default to subtract time between `suspended` and `running` status events).
3. On violation: record `budget_exceeded` then `run_status_changed running->failed reason budget_exceeded`.
4. Cost uses `usage.costMicros` (sum of `model_response.costMicros`), ignoring responses without it; the gateway populates it in 14.14.
5. Budgets are inherited by subagents in 23.4.
**Tests to write:** each budget boundary (equal to the limit allowed, one over fails); wall-clock with suspended-time subtraction using the fake clock; resume does not reset budgets; exit code mapping in CLI.
**Acceptance Criteria:**
- [ ] Each budget enforced and tested at its boundary.
- [ ] Exceeding ends the run `failed` with reason `budget_exceeded`.
- [ ] Budgets persist across resume.

---

## 2.13 `harness cancel` with cooperative cancellation

**Parent:** #2 Run loop
**Task Description:** Cancel a run from another process using the same conflict mechanism, with the live worker stopping gracefully.
**Expected Inputs:** `runId`.
**Expected Output:** `packages/core/src/cancel.ts` (`cancelRun`), `LeaseLostError` handling that inspects the log tail, `packages/cli/src/commands/cancel.ts`.
**Dependencies:** none.
**Items it depends on:** 2.7, 2.10.
**Implementation guidance:**
1. `cancelRun(store, runId, clock, ids)`: read head and state; if terminal, return `already_terminal`; else append `run_status_changed {from: current, to: cancelled, reason: cancel_requested}` with `expectedSeq = head`. Retry the read-then-append up to 3 times if the head moved because the live worker appended.
2. In the live loop, on `lease_lost` call `inspectTail(store, runId, recorder.nextSeq)`: if the tail contains a `run_status_changed` to `cancelled`, abort in-flight work via the `AbortController`, stop without further appends, and return `{ status: "cancelled" }`; otherwise treat as another worker owning the run and exit with `lease_lost`.
3. A suspended run is cancelled directly (no worker to stop).
4. A tool aborted by cancellation leaves a dangling intent; cancelled runs are terminal so nothing resumes it. Record nothing further.
5. CLI: `harness cancel <runId>` exits 0 on success, 1 if already terminal.
**Tests to write:** cancel while the loop waits on a slow fake tool: tool receives abort, loop returns cancelled, no appends after cancel event; cancel suspended run; cancel terminal run; conflict retries; a different-worker conflict is not mistaken for cancel.
**Acceptance Criteria:**
- [ ] A live worker stops within one step of a cancel event.
- [ ] The log ends with exactly one `cancelled` status event.
- [ ] Cancel of a finished run is a clean no-op.

---

## 2.14 Run continuations: follow-up messages to a finished run

**Parent:** #2 Run loop
**Task Description:** Let a user continue a finished conversation with a new message by creating a linked continuation run, keeping terminal states absorbing.
**Expected Inputs:** A terminal `runId`, a follow-up input `{ goal: string, metadata? }`.
**Expected Output:** `packages/core/src/continue.ts` (`continueRun`), schema change adding `continuationOf?: Id` (meta) to `run_created` and the `inputKind` value `follow_up` for `run_input`, transcript support for continuation chains in `packages/context/src/transcript.ts`, CLI `packages/cli/src/commands/continue.ts` (`harness continue <runId> --input <file|->`), docs section in `docs/cli.md`.
**Dependencies:** none.
**Items it depends on:** 2.10, 15.1, 23.2, 7.1.
**Implementation guidance:**
1. Terminal states stay absorbing: a continuation is a **new run** whose `run_created.continuationOf` names the previous run. Only `completed` runs can be continued by default (`run.continuations.allowFromFailed: false`). Continuing a `running` or `suspended` run fails with `run_not_terminal` (use resume or answer the pending approval/input instead).
2. Token scope: the continuation registers the same scope as the run it continues (`RunScopeRegistry`, 23.2), so tokens in earlier turns keep resolving. Vault purge (12.6) treats a continuation chain as one scope: the scope is purged only when every run in it is terminal past the grace period.
3. Context: `eventsToTranscript` accepts an ordered chain of logs (oldest first, found by following `continuationOf`), concatenates their groups, and appends the new run's groups. Only the newest `run_input` is pinned. Chain length is capped by `run.continuations.maxChainLength` (default 50, `continuation_chain_too_long`).
4. Branching is allowed: two continuations of the same run are independent runs. Document it; `harness inspect` lists known continuations via `listRuns` filtering on `continuationOf` (add the index in the store migration).
5. Budgets apply to each continuation run on its own; `run.continuations.inheritBudgets: true` optionally subtracts the chain's usage (folded from ancestor logs).
6. Telemetry: the continuation's root `harness.run` span has a span link to the previous run's root span context; add optional attribute `harness.run.continuation_of` (id). Replay (9.1) loads the ancestor chain when resolving a continuation.
**Tests to write:** continue a completed run and see the earlier turns in the built context; non-terminal run rejected; tokens from the first run resolve in the continuation; chain cap; branching produces independent runs; `inheritBudgets` arithmetic; span link present; replay of a continuation resolves its chain.
**Acceptance Criteria:**
- [ ] A finished conversation can be continued without mutating its log.
- [ ] Tokens keep their meaning across a continuation chain.
- [ ] Terminal states remain absorbing.
