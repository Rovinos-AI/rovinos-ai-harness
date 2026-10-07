# Epic #15: Context strategy

**Goal:** context is a **view derived from the immutable event log**, produced by pluggable strategies, so any run can be rebuilt, compared, and re-derived with a different strategy. Read `docs/engineering/CONVENTIONS.md` first.
**Tasks:** 15.1 to 15.8, all size S.

Shared design for this epic:
- `packages/context` exports `ContextStrategy` and implementations. Strategies are **pure** with respect to the log: given events (and optionally a snapshot), they return messages. Side effects (summarizing with a model, writing offloaded files) happen in explicit run-loop steps that record events, never inside `build`.
- The transcript is reconstructed from these events only: `run_input` (user goal), `model_response` (assistant messages, including opaque blobs), `tool_result` (tool messages), `context_compacted` (replaces a seq range with a summary). Approval and status events never enter the transcript.
- Atomic groups: an assistant message containing `tool_call` parts and its `tool_result` messages form one group and are kept or dropped together.

---

## 15.1 `ContextStrategy` interface, transcript reconstruction, and the core adapter

**Parent:** #15 Context strategy
**Task Description:** Define the strategy interface, build the pure transcript reconstruction, add the missing `run_input` event, and bridge strategies to the run loop's `ContextPort`.
**Expected Inputs:** `Event[]`, optional snapshot, token budget, model reference.
**Expected Output:** `packages/context/src/{types.ts,transcript.ts,context-port.ts,index.ts}`, new event type `run_input` in `@harness/schemas`, `ContextPort.snapshot/restore` implementation, package scaffold.
**Dependencies:** none.
**Items it depends on:** 7.1, 14.2, 2.3, 2.6.
**Implementation guidance:**
1. **Schema change:** add event `run_input { input: JsonValue (content), inputKind: Code (meta) }` recorded by the run loop immediately after `run_created` (update `runLoop` in 2.3 and the CLI in 2.10 to record it; update classification and goldens; update `docs/engineering/CONVENTIONS.md` §4 event list).
2. Interface:
```ts
interface ContextStrategy {
  readonly id: Code; readonly version: Code;
  build(input: { events: readonly Event[]; budget: { maxTokens: number; reserveOutputTokens: number }; model: ModelRef; counter: TokenCounter }): Promise<ContextResult>;
}
type ContextResult = { messages: Message[]; stats: { messageCount: number; estimatedTokens: number; droppedGroups: number; compactedRanges: number; offloadedResults: number }; pinnedSeqs: number[] };
```
3. `eventsToTranscript(events): TranscriptGroup[]`: `run_input` -> one user message group (pinned); `model_response` -> assistant message from `content` parts; each following `tool_result` -> tool message with `{ type: "tool_result", callId, result, isError: outcome !== "ok" }`; groups join an assistant message with its tool results (matched by `callId`). A `context_compacted` event removes groups whose seqs fall in `[fromSeq, toSeq]` and inserts a summary message group (role `user`, text `"Summary of earlier work: ..."`), ordered at `fromSeq`.
4. `StrategyContextPort implements ContextPort` (core): `build(events)` calls the strategy; `snapshot()` returns `{ strategyId, strategyVersion, calibration }`; `restore(snapshot, eventsAfter)` restores calibration only (the transcript is always rebuilt from events).
5. Provide `NaiveStrategy` (all groups, no limits) replacing core's `NaiveContext`.
**Tests to write:** transcript reconstruction goldens (plain run, tool run, compacted run); atomic group integrity (tool results always follow their call); compaction replaces the exact range; `run_input` pinned; snapshot/restore round trip; run loop integration test still passes.
**Acceptance Criteria:**
- [ ] A run's context can be rebuilt from its log alone.
- [ ] Tool calls are never separated from their results.
- [ ] `run_input` exists in schema, classification, and the loop.

---

## 15.2 Sliding-window strategy

**Parent:** #15 Context strategy
**Task Description:** Keep pinned groups plus the most recent groups that fit the token budget.
**Expected Inputs:** Transcript groups, budget, `TokenCounter`.
**Expected Output:** `packages/context/src/strategies/sliding-window.ts` (id `sliding_window`, version `v1`).
**Dependencies:** none.
**Items it depends on:** 15.1, 15.3.
**Implementation guidance:**
1. Available tokens = `budget.maxTokens - budget.reserveOutputTokens`.
2. Always keep pinned groups (the `run_input` group, the plan injection from 15.6, summary groups). If pinned groups alone exceed the budget throw `context_pinned_exceeds_budget`.
3. Walk non-pinned groups from newest to oldest, adding while the running estimate stays within the budget. Never split a group. Stop at the first group that does not fit (do not skip to older small groups, to preserve contiguity).
4. Emit a short synthetic marker message when groups were dropped: role `user`, text `"[N earlier steps omitted]"` placed before the kept groups (counted in tokens).
5. Return stats (`droppedGroups`).
**Tests to write:** fits entirely; drops oldest; pinned always present; atomic groups; marker inserted only when something dropped; pinned-too-large error; determinism (same input same output).
**Acceptance Criteria:**
- [ ] Output never exceeds the available token estimate.
- [ ] Contiguity and group atomicity preserved.
- [ ] Marker present exactly when groups were dropped.

---

## 15.3 Per-model token-counting abstraction

**Parent:** #15 Context strategy
**Task Description:** Provide a pluggable token counter with a conservative default and calibration from real usage.
**Expected Inputs:** Messages, model reference, real `usage.inputTokens` observations.
**Expected Output:** `packages/context/src/token-counter.ts` (`TokenCounter`, `HeuristicTokenCounter`, `CalibratingTokenCounter`).
**Dependencies:** none.
**Items it depends on:** 14.2.
**Implementation guidance:**
1. `interface TokenCounter { count(messages: readonly Message[], model: ModelRef): number }`.
2. `HeuristicTokenCounter`: estimate = `ceil(totalCharacters / 3.5) + 4 * messageCount + 8 * toolCallPartCount`, then multiply by `safetyFactor` (default 1.15). Text length counts `text` parts and `JSON.stringify` of tool args/results; `opaque` parts count their serialized length.
3. `CalibratingTokenCounter(inner)`: keeps per-`provider/model` exponential moving average of `actual / estimated` (alpha 0.3, clamp 0.5 to 2.0), updated via `observe(model, estimated, actualInputTokens)`; `count` multiplies the inner estimate by the ratio. The ratio is stored in the context snapshot (15.1) and restored on resume.
4. The run loop calls `observe` after each `model_response` using the estimate computed at build time.
5. Exact tokenizers can be added later by implementing the interface; do not add heavy tokenizer dependencies here.
**Tests to write:** heuristic on fixed samples within expected ranges; monotonic with content length; calibration converges toward a synthetic true ratio; clamp bounds; snapshot persistence round trip.
**Acceptance Criteria:**
- [ ] Estimates are conservative (never below a simple chars/4 baseline).
- [ ] Calibration improves estimates in a simulated series.
- [ ] Interface allows swapping in exact counters.

---

## 15.4 Offload large tool outputs to workspace files with handles

**Parent:** #15 Context strategy
**Task Description:** Replace very large tool results with a small stub and store the full output as a workspace file the model can page through.
**Expected Inputs:** `ToolPort` results, `WorkspacePort`, threshold config.
**Expected Output:** `packages/context/src/offload.ts` (`OffloadingToolPort` decorator), `WorkspacePort` interface and `InMemoryWorkspace`, built-in tool `read_offloaded`.
**Dependencies:** none.
**Items it depends on:** 15.1, 2.4.
**Implementation guidance:**
1. `interface WorkspacePort { write(path: string, data: Uint8Array): Promise<void>; read(path: string, range?: { offset: number; length: number }): Promise<Uint8Array>; }` (the real sandbox-backed implementation arrives in 19.5). Paths are workspace-relative and must be under `.harness/offload/`; reject `..`, absolute paths, and symlinks.
2. `OffloadingToolPort(inner, workspace, { thresholdBytes: 8192, previewChars: 400 })`: after `inner.execute`, if `JSON.stringify(result).length > thresholdBytes`, write the serialized result to `.harness/offload/<handle>.json` (`handle = "wf_" + ulid`) and return `{ "$offloaded": { handle, bytes, preview } }` as the result. The stub is a Zod schema (`OffloadedStub`) shared with replay and the context builder (CONVENTIONS 3.10).
3. **Ordering rule (document in code):** PII tokenization (13.7) runs on tool output **before** offloading, so files and previews contain tokens only.
4. Built-in `read_offloaded({ handle, offset?, length? })` returns at most 16 KB per call, with `{ data, nextOffset?, totalBytes }`; unknown handle returns `outcome: "error"`, errorCode `handle_not_found`. Register it as an idempotent tool.
5. Record the handle and byte length inside the stored result stub so replay never needs the file.
**Tests to write:** below threshold untouched; above threshold writes file and returns stub; path safety (traversal rejected); `read_offloaded` paging boundaries; handles unique; preview limited and contains no bytes beyond `previewChars`.
**Acceptance Criteria:**
- [ ] Large results never enter the transcript in full.
- [ ] The model can page the full content through `read_offloaded`.
- [ ] Path traversal attempts are rejected.

---

## 15.5 Summarization compaction

**Parent:** #15 Context strategy
**Task Description:** Compact the oldest portion of a long transcript by summarizing it, recorded as a `context_compacted` event so the strategy stays pure.
**Expected Inputs:** Transcript, token estimate, summarizer model role.
**Expected Output:** `packages/context/src/strategies/summarizing.ts` (id `summarizing`, version `v1`), `packages/core/src/steps/compaction-step.ts`, `Summarizer` port.
**Dependencies:** none.
**Items it depends on:** 15.2, 14.13, 2.2.
**Implementation guidance:**
1. `Summarizer.summarize({ groups, goal }): Promise<{ text: string; usage }>` implemented via `ModelPort` with role `summarizer` and an instruction to preserve: the goal, decisions made, open tasks, key facts and identifiers (tokens such as `<EMAIL_1>` verbatim), tool outcomes, and errors encountered.
2. `SummarizingStrategy.needsCompaction(events, budget, counter)`: true when estimated tokens exceed `triggerRatio` (default 0.75) of the available budget.
3. `compactionStep`: select the range to compact = oldest non-pinned groups up to (but excluding) the most recent `keepRecentGroups` (default 6), not overlapping earlier compactions (start at `previousCompactedTo + 1`). Call the summarizer, then record `context_compacted { fromSeq, toSeq, strategy, strategyVersion, summary }` through the recorder inside the `harness.compaction` span. The summary text is content and passes the PII boundary like any model output.
4. `build` is pure: it applies `context_compacted` events (15.1), then falls back to sliding-window behavior for anything still over budget.
5. Nested compaction: a later `context_compacted` whose range covers an earlier summary supersedes it (the earlier summary group is removed from the transcript).
6. The loop calls `needsCompaction` before each model call.
**Tests to write:** trigger boundary; range selection excludes pinned and recent groups; non-overlap; nested compaction supersedes; `build` purity (does not call the summarizer, verified with a throwing fake); summarizer receives tokens verbatim; event recorded exactly once.
**Acceptance Criteria:**
- [ ] Compaction is an auditable event with its source range.
- [ ] Rebuilding from the log yields the same context without model calls.
- [ ] Nested compaction supported.

---

## 15.6 Pinned items and a plan kept outside the conversation

**Parent:** #15 Context strategy
**Task Description:** Give the model a durable plan and notes via built-in tools whose state is derived from the log, and always include it in context.
**Expected Inputs:** `update_plan` tool calls, events.
**Expected Output:** `packages/context/src/plan.ts` (`PlanSchema`, `derivePlan`), `packages/context/src/builtin-tools.ts` (`update_plan`, `read_plan`), strategy integration (pinned plan message).
**Dependencies:** none.
**Items it depends on:** 15.2, 2.4.
**Implementation guidance:**
1. `Plan = { items: { id: Code, text: string(max 500), status: "todo"|"doing"|"done" }[] (max 50), notes: string (max 4000) }`.
2. `update_plan({ plan: Plan })` replaces the plan; `read_plan()` returns it. Both are idempotent tools executed in-process (no sandbox).
3. `derivePlan(events)`: fold over `tool_intent` events with `toolId === "update_plan"` whose matching `tool_result` has `outcome === "ok"`; latest wins. Pure; no new event types.
4. Strategies append a pinned message at the end of the context: role `user`, text `"Current plan: ..."` rendered from `derivePlan` (render deterministically). Include its token cost in the pinned total.
5. `RunState.plan` (2.6 snapshot) is populated from `derivePlan` at checkpoint time for fast inspection.
6. Plan text is model-written content, so it flows through the PII boundary like other content; no special handling.
**Tests to write:** derive from a sequence of updates; failed tool call does not change the plan; invalid plan rejected by the tool; plan message present in every strategy output and never dropped; size limits.
**Acceptance Criteria:**
- [ ] Plan survives compaction and sliding-window dropping.
- [ ] Plan state is reconstructible from the log alone.
- [ ] Schema limits enforced.

---

## 15.7 `harness context` CLI for inspecting and re-deriving context

**Parent:** #15 Context strategy
**Task Description:** Let developers see what context a strategy produces for a stored run without calling any model.
**Expected Inputs:** `runId`, strategy name, token budget.
**Expected Output:** `packages/cli/src/commands/context.ts`, strategy registry `packages/context/src/registry.ts`, docs in `docs/cli.md`.
**Dependencies:** none.
**Items it depends on:** 15.2, 15.5, 15.6, 20.2.
**Implementation guidance:**
1. `harness context <runId> [--strategy naive|sliding_window|summarizing] [--max-tokens N] [--reserve-output N] [--model provider/model] [--show-content] [--json]`.
2. Read-only: load events, call `strategy.build`, never write events or call models. The summarizing strategy uses only existing `context_compacted` events.
3. Default output is metadata: message count, estimated tokens, group counts, dropped groups, compacted ranges (seq ranges), offloaded handles (ids and byte sizes), pinned seqs. `--show-content` additionally prints message text (tokenized content from the store) with a stderr warning.
4. Unknown strategy lists available ones and exits 2.
**Tests to write:** CLI tests with an in-memory store: metadata output, `--json` shape, `--show-content` gate, unknown strategy exit code, no store writes (spy on `append`).
**Acceptance Criteria:**
- [ ] No content printed without `--show-content`.
- [ ] Command performs no writes and no model calls.
- [ ] Works for any stored run and any registered strategy.

---

## 15.8 Strategy version attributes and eval comparison hook

**Parent:** #15 Context strategy
**Task Description:** Record which strategy and version produced each model request and provide an offline comparison API for evals.
**Expected Inputs:** `ContextResult.stats`, strategy identity.
**Expected Output:** span attributes on `harness.model_call` (`harness.context.strategy`, `harness.context.strategy_version`, `harness.context.estimated_tokens`, `harness.context.message_count`), `packages/context/src/compare.ts` (`compareStrategies`), `harness context --compare a,b`.
**Dependencies:** none.
**Items it depends on:** 15.7, 4.1.
**Implementation guidance:**
1. Add the four attributes to the `harness.model_call` span definition (types: code, code, int, int) and populate them where the loop builds context. Update the attribute catalog (4.7).
2. Version bump policy: any change that alters output for the same input requires a new `version` Code (`v2`, ...); add a golden-output test per strategy that fails if output changes without a version bump (the test stores the strategy's `version` next to the golden file and asserts they correspond).
3. `compareStrategies(events, strategies, options): Comparison[]` returns per strategy: token estimate, message count, dropped groups, compacted ranges, and `retainedSeqs`. Add `coverage(a, b)`: fraction of `b`'s retained seqs also retained by `a`.
4. `--compare a,b` in the CLI prints a table; JSON mode prints the structure.
5. The eval runner (16.1) will accept a `contextStrategy` field; expose a registry lookup helper for it.
**Tests to write:** attributes present on spans in a run test (spy exporter); golden/version guard test with a deliberately modified strategy proving it fails; comparison math on fixtures; CLI table output snapshot.
**Acceptance Criteria:**
- [ ] Every model-call span records strategy id and version.
- [ ] Changing strategy output without a version bump fails CI.
- [ ] Two strategies can be compared on a stored run offline.
