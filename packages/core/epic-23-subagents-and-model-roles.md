# Epic #23: Subagents and model roles

**Goal:** let a run delegate work to subagents with isolated context, bounded budgets, durable resume, schema-checked results, and distinct model roles (planner, worker, judge, summarizer). Read `docs/engineering/CONVENTIONS.md` first, plus epics 2, 13, 14, 15, and 17.
**Tasks:** 23.1 to 23.6, all size S.

Shared design for this epic:

- **A subagent is a separate run** with its own event log, transcript, checkpoints, and segments, linked to its parent by `parentRunId` in `run_created`, `subagent_spawned`/`subagent_completed` events in the parent, and a span link.
- **Shared vault scope.** Tokens such as `<EMAIL_1>` are scoped by a `scopeId`, which is the **root run id** for the whole tree. A subagent receives its parent's tokens verbatim and they keep meaning the same thing. Implement via a `RunScopeRegistry` (23.2) that maps `runId -> scopeId`; the tokenizer, detokenizer, auditing resolver, reveal tool, and leak sentinel (8.3) must resolve the scope through it instead of using `runId` directly.
- **Subagents cannot widen authority:** their tool set, budgets, depth, and policy context are subsets of the parent's.
- **Deterministic resume:** `subagent_spawned` is appended **before** the child starts, so a crash never loses track of a child or duplicates one.

---

## 23.1 Role configuration

**Parent:** #23 Subagents and model roles
**Task Description:** Define roles that bind a model route, prompt, tool subset, budgets, and context strategy.
**Expected Inputs:** `roles:` section of the config.
**Expected Output:** `packages/schemas/src/config/roles.ts` (`RoleConfig`), `packages/core/src/roles.ts` (`resolveRole`, `RoleRegistry`), built-in role defaults, docs `docs/roles.md`.
**Dependencies:** `zod`.
**Items it depends on:** 14.13, 15.7, 20.1.
**Implementation guidance:**

1. `RoleConfig = { id: Code, route?: Code (a key in models.routing.roles, default same as id), systemPrompt?: string (max 8000) | { file: string }, tools: Code[] | "*" (tool ids or glob patterns like fs.*), budgets?: { maxSteps?, maxCostUsd?, maxWallClockMs? }, contextStrategy?: Code, resultSchema?: string (module path#export), maxDepth?: int (default 2), maxChildren?: int (default 8) }`.
2. Built-in roles with defaults: `planner`, `worker`, `judge`, `summarizer` (the summarizer role is used by 15.5 and the judge by 16.5 and 23.6). Config can override them; missing config uses conservative defaults (`tools: []` for judge and summarizer).
3. Validation at startup: referenced routes exist in `models.routing`, tool patterns match at least one registered tool (warn code `role_tool_pattern_unmatched` otherwise), `contextStrategy` exists in the registry (15.7), `resultSchema` module loads and exports a Zod schema, no duplicate ids.
4. `resolveRole(name)` returns a frozen resolved role. System prompt files are read at startup (path must be inside the config directory; reject traversal).
5. System prompt text is operator-authored and treated as trusted instructions; it is still recorded content in `model_request` events like any message.
**Tests to write:** valid and invalid role sets; glob tool patterns; built-in defaults and overrides; prompt file traversal rejected; resultSchema loading failure; deep-frozen result.
**Acceptance Criteria:**

- [ ] Misconfigured roles fail at startup with precise codes.
- [ ] Built-in roles exist with safe defaults.
- [ ] Prompt files cannot escape the config directory.

---

## 23.2 Subagent spawn with isolated context, shared scope, and span link

**Parent:** #23 Subagents and model roles
**Task Description:** Add the built-in `agent.spawn` tool and the `RunScopeRegistry`, creating and running a child run.
**Expected Inputs:** `agent.spawn { role, goal, inputs? }` tool calls.
**Expected Output:** `packages/core/src/subagent/{spawn-tool.ts,supervisor.ts,scope.ts}`, schema change adding `parentCallId?: Id` and `depth: int` (meta) to `run_created`, `RunScopeRegistry`, updates to the sentinel scope lookup (8.3) and PII/vault callers.
**Dependencies:** none.
**Items it depends on:** 23.1, 2.10, 13.7, 8.3.
**Implementation guidance:**

1. `RunScopeRegistry`: `register(runId, scopeId)`, `scopeOf(runId): Id` (defaults to `runId` for roots). Update `VaultRunView.valuesFor` (8.1), the tokenizer and detokenizer entry points (13.4, 13.5), the auditing resolver (12.7), and the reveal tool (18.4) to call `scopeOf` before touching the vault.
2. `agent.spawn` is a built-in tool (id `agent.spawn`, non-idempotent) whose input schema is `{ role: Code, goal: string (max 8000), inputs?: JsonValue }`. The policy engine (17.x) sees it like any other tool (ship `examples/policy.yaml` with `ask` by default).
3. Spawn flow inside the tool executor: check depth (`parent.depth + 1 <= role.maxDepth`) and children count; generate `childRunId`; **append `subagent_spawned { childRunId, role, parentCallId }` to the parent's log first**; create the child run: `run_created { parentRunId, parentCallId, depth, ... }`, `run_input { input: goal + inputs }` (tokenized like any content), register scope; start the child loop with the role's route, prompt, tool subset, and strategy.
4. The child's tool registry is the intersection of the parent's registry and `role.tools`; attempts to call other tools return `unknown_tool`.
5. Telemetry: the child's root `harness.run` span has a **link** to the parent's `harness.tool_call` span and, when in the same process, uses it as parent; add optional attribute `harness.run.parent_id` (id) and `harness.run.depth` (int) to `harness.run` (catalog and collector allowlist refresh).
6. The tool awaits the child's result (23.3) and returns it as the spawn call's `tool_result`. If the child suspends for approval, the parent also suspends with reason `awaiting_subagent` (see 23.5 for resume).
**Tests to write:** spawn creates a child log with correct `parentRunId`/`depth`; tokens from the parent resolve in the child (same scope) and the sentinel uses the shared scope (canary in the child's span is caught); tool subset enforced; depth and children limits; ordering: `subagent_spawned` durable before child events (spy store); span link present.
**Acceptance Criteria:**

- [ ] Children have isolated logs and contexts but share token scope.
- [ ] `subagent_spawned` is always recorded before the child starts.
- [ ] Children cannot use tools outside the role/parent intersection.

---

## 23.3 Result contract for subagent output

**Parent:** #23 Subagents and model roles
**Task Description:** Validate subagent final answers against a role-defined Zod schema and return a typed result to the parent.
**Expected Inputs:** Child final output, role `resultSchema`.
**Expected Output:** `packages/core/src/subagent/result.ts` (`SubagentResult`, `finalizeChild`), enforcement wiring through the gateway `outputSchema`, schema change adding `inputTokens`, `outputTokens`, `costMicros` (meta ints) to `subagent_completed`.
**Dependencies:** none.
**Items it depends on:** 23.2, 14.10, 13.10.
**Implementation guidance:**

1. `SubagentResult = { childRunId: Id, status: "completed"|"failed"|"cancelled"|"suspended", value?: JsonValue, errorCode?: Code, usage: { inputTokens, outputTokens, costMicros? } }`.
2. When the role defines `resultSchema`, the child's **last** model call uses the enforcement ladder with that schema (pass `outputSchema` and the `valueTransform` from 13.10 so token-aware validation works). If the role has no schema, `value` is the final text wrapped as `{ text: string }`.
3. On validation exhaustion (`model_output_invalid`), the child run fails with reason `result_invalid`; the parent's `tool_result` for the spawn call is `outcome: "error"`, `errorCode: "subagent_result_invalid"`.
4. `subagent_completed` event (appended to the parent log when the child reaches a terminal state or suspends is **not** recorded; only terminal) carries outcome plus usage totals aggregated from the child's log (the parent fold uses them for budgets, 23.4).
5. The returned `value` stays tokenized (it is content in the parent's `tool_result`); no raw values are produced.
**Tests to write:** valid result returned and typed; invalid result leads to `subagent_result_invalid`; no-schema role returns `{ text }`; usage aggregation accuracy; token-aware validation works for an email-format field.
**Acceptance Criteria:**

- [ ] Parents receive validated, typed results or a typed error.
- [ ] Child usage is recorded on the parent log.
- [ ] Results are never detokenized implicitly.

---

## 23.4 Budget inheritance and cancellation propagation

**Parent:** #23 Subagents and model roles
**Task Description:** Ensure children cannot exceed the parent's remaining budgets and that cancellation reaches the whole tree.
**Expected Inputs:** Parent state, role budgets, cancel requests.
**Expected Output:** `packages/core/src/subagent/budgets.ts` (`deriveChildBudgets`), updates to `foldRunState` (include child usage), `cancelRun` tree propagation, config `run.subagents` limits.
**Dependencies:** none.
**Items it depends on:** 23.3, 2.12, 2.13.
**Implementation guidance:**

1. `deriveChildBudgets(parentState, parentBudgets, roleBudgets, now)`: `maxSteps = min(role.maxSteps ?? Infinity, parentBudgets.maxSteps - parentState.steps)` (never below 1; if the parent has no steps left, spawning fails with `budget_exceeded`), `maxCostUsd = min(role, parentRemaining)`, wall-clock deadline = `min(role deadline, parent deadline)`.
2. Parent fold: `usage` includes the sum of `subagent_completed` usage fields so parent budgets account for child spend. To avoid double counting, spawn-time reservations are not used; instead cost is checked against **remaining** at spawn and again as the child runs (the child's own budgets are capped as above, so the sum cannot exceed the parent's limit).
3. Cancellation: `cancelRun(parent)` collects children from `subagent_spawned` without `subagent_completed`, cancels each (recursively) and then the parent; live child loops also receive an `AbortSignal` derived from the parent's controller. A child cancelled this way records its terminal event and the parent records `subagent_completed { outcome: "cancelled" }`.
4. Limits: `run.subagents.maxDepth` (global ceiling 4), `maxChildrenPerRun` (default 8), `maxConcurrentChildren` (default 2). Spawn beyond limits returns `outcome: "error"` with `errorCode: "subagent_limit"`.
**Tests to write:** budget derivation table (parent nearly exhausted, role larger/smaller than parent); end-to-end cost cap across parent and two children; cancel propagation (live and suspended children); limit enforcement; no double counting of usage.
**Acceptance Criteria:**

- [ ] Parent plus children never exceed the parent's budgets.
- [ ] Cancelling a parent reliably cancels descendants.
- [ ] Limits are configurable and enforced.

---

## 23.5 Resume semantics for in-flight subagents

**Parent:** #23 Subagents and model roles
**Task Description:** Make parent resume correctly continue, deliver, or recover children.
**Expected Inputs:** Parent log with `subagent_spawned` events and possibly dangling spawn calls.
**Expected Output:** `packages/core/src/subagent/resume.ts`, a per-tool resume strategy hook in the resume policy (2.5), crash-injection scenario additions (2.11).
**Dependencies:** none.
**Items it depends on:** 23.2, 23.4, 2.5, 2.7, 2.11.
**Implementation guidance:**

1. Add `ToolResumeStrategy` to the planner (2.5): tools can provide a custom `onDanglingIntent(call, state)`; `agent.spawn` registers one.
2. Cases for a dangling `agent.spawn` intent on parent resume:
   - **No `subagent_spawned` for this `callId`:** the crash happened before any child existed; safe to re-run the spawn (the strategy returns `rerun`).
   - **`subagent_spawned` exists, child terminal:** append the missing `subagent_completed` (idempotent: skip if present), then record the spawn `tool_result` from the child's result.
   - **Child non-terminal (running or suspended):** resume the child (`resumeRun(childRunId)`) and await it, then deliver the result; if the child suspends for approval, the parent re-suspends with `awaiting_subagent`.
   - **Child log missing:** `tool_result` outcome `error`, `errorCode: "subagent_missing"`.
3. A resumed child uses the same `RunScopeRegistry` mapping (re-register on resume from `run_created.parentRunId`/scope derivation: scope = scope of parent, resolved by walking `parentRunId` links).
4. Extend `CrashingEventStore` scenarios (2.11) with a spawn scenario crashing at every append boundary across parent and child logs; assert exactly one child per spawn call and a non-idempotent tool inside the child executes once.
**Tests to write:** each of the four cases; scope re-registration; crash-injection matrix with a child; double-resume race on the same parent (one wins) and the child is not resumed twice.
**Acceptance Criteria:**

- [ ] No crash point creates duplicate children or loses a child.
- [ ] Parent resumes and delivers child results in all four cases.
- [ ] Non-idempotent tools inside children execute exactly once.

---

## 23.6 Judge and verifier helper

**Parent:** #23 Subagents and model roles
**Task Description:** Offer a runtime self-check tool backed by the `judge` role with schema-enforced verdicts.
**Expected Inputs:** Criteria and subject to verify.
**Expected Output:** `packages/schemas/src/verdict.ts` (verdict schema moved from 16.5), `packages/core/src/builtin/verify-tool.ts` (`agent.verify`), docs `docs/roles.md` section.
**Dependencies:** none.
**Items it depends on:** 23.1, 16.5, 14.10.
**Implementation guidance:**

1. Move the verdict schema from 16.5 to `@rovinos/schemas` and update 16.5 to import it. Verdict: `{ criteria: { id: Code, met: boolean }[], verdict: "pass" | "fail" }` with no free-text field.
2. `agent.verify { criteria: { id: Code, description: string (max 500) }[] (1..10), subject: JsonValue }` (idempotent, read-only) makes **one** model call with role `judge` through the gateway with `outputSchema` built dynamically so `criteria[*].id` must be one of the supplied ids and every id appears exactly once (use a refinement); temperature 0.
3. The subject and descriptions pass through the standard PII boundary (they reach a model); the tool result is the validated verdict.
4. Records are ordinary `model_request`/`model_response` and `tool_result` events in the parent log (no child run). Costs count against the parent's budgets.
5. Failures after repair attempts return `outcome: "error"`, `errorCode: "verify_failed"`.
**Tests to write:** valid verdict; missing or extra criterion ids rejected and repaired; PII canary in subject is tokenized before the judge fake provider sees it; cost accounted; idempotent behavior on resume (re-run allowed); 16.5 still passes with the moved schema.
**Acceptance Criteria:**

- [ ] Verdicts are structurally enforced and content-free.
- [ ] The tool respects the PII boundary and budgets.
- [ ] The eval judge and runtime verifier share one schema.
