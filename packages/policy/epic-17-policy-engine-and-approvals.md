# Epic #17: Policy engine and approvals

**Goal:** decide, outside the model and deterministically, whether each tool call is allowed, needs a human, or is denied; make approvals durable, editable, expiring, and auditable. Read `docs/engineering/CONVENTIONS.md` first, plus epics 2 (suspension) and 13 (tokenized arguments).
**Tasks:** 17.1 to 17.9, all size S.

Shared design for this epic:
- **The model never decides.** Policy runs in code on the **tokenized** arguments (raw values are never visible to the policy engine).
- **Most restrictive wins.** Among matching rules, `deny` beats `ask` beats `allow`, independent of rule order. No match means the default decision, which can only be `ask` or `deny` (never `allow`).
- **Approvals are log entries, not connections.** A suspended run needs no live process; any process can resolve an approval (2.9).
- Package `packages/policy` depends on `schemas` and `telemetry` only. The run loop integration lives in `core`.

---

## 17.1 Policy schema

**Parent:** #17 Policy engine and approvals
**Task Description:** Define the policy document format, with validation that prevents unsafe configurations.
**Expected Inputs:** YAML or JSON policy files.
**Expected Output:** `packages/policy/src/schema.ts` (`PolicyDocument`, `Rule`, `ArgMatcher`), `packages/schemas/src/config/policy.ts` (config fragment `policy.file`), `loadPolicy(path)`, `policyVersion(doc)`, `examples/policy.yaml`, package scaffold `packages/policy`.
**Dependencies:** `yaml`.
**Items it depends on:** 7.1, 20.1.
**Implementation guidance:**
1. `PolicyDocument = { version: 1, defaultDecision: "ask" | "deny", rules: Rule[] }`.
2. `Rule = { id: Code, description?: string, match: { tools: Code[] | "*", args?: ArgMatcher[], context?: { subagent?: boolean, server?: Code } }, decision: "allow" | "ask" | "deny", reason: Code, editable?: JsonPointer[], approvalTtlMs?: int, escalateAfterMs?: int }`. Tool patterns may end with `.*` (for example `fs.*`) as the only wildcard form.
3. `ArgMatcher = { pointer: JsonPointer, op: "equals" | "in" | "startsWith" | "matches" | "exists" | "tokenType", value?: JsonValue }`. `matches` regexes must pass the ReDoS screen shared from `packages/pii/src/detectors/custom.ts` (move it to a small shared helper in `schemas`). `tokenType` compares the entity type of a token string such as `<EMAIL_1>` (value `email`).
4. Validation: unique rule ids; reject a rule combining `tools: "*"` with `decision: "allow"` (`policy_allow_all`); reject `editable` pointers on non-`ask` rules; `escalateAfterMs` requires `ask`.
5. `policyVersion(doc)` = `"pol-" + first 12 hex of SHA-256` of the canonical JSON of the document.
6. Document in `docs/policy.md` that policies see tokens, not raw values, and how to write rules with `tokenType`.
**Tests to write:** valid sample; each rejection; version stability across key order; pointer and wildcard syntax validation; ReDoS-unsafe `matches` rejected; `defaultDecision: "allow"` rejected by the schema.
**Acceptance Criteria:**
- [ ] Unsafe policies cannot be loaded.
- [ ] Policy version is deterministic.
- [ ] Documented example policy exists and validates.

---

## 17.2 Deterministic evaluator with precedence and explain output

**Parent:** #17 Policy engine and approvals
**Task Description:** Implement the pure policy evaluator.
**Expected Inputs:** `PolicyDocument`, a call `{ toolId, args, context }` with tokenized args.
**Expected Output:** `packages/policy/src/evaluate.ts` (`evaluate`), `Explanation` type.
**Dependencies:** none.
**Items it depends on:** 17.1.
**Implementation guidance:**
1. `evaluate(doc, call): { decision; ruleId: Code | "default"; reason: Code; matched: { ruleId; decision }[]; editable: JsonPointer[]; approvalTtlMs?; escalateAfterMs? }`.
2. A rule matches when the tool pattern matches `toolId`, every `ArgMatcher` holds (a pointer that does not exist makes `equals/in/startsWith/matches/tokenType` false and `exists` false), and context conditions hold.
3. Combine matches: pick the most restrictive decision (`deny` > `ask` > `allow`); among rules with that decision pick the first in document order for `ruleId`, `reason`, `editable`, TTL, escalation. If none match, use `defaultDecision` with `ruleId: "default"` and reason `default_decision`.
4. `explain` mode returns all matched rules in order (used by 17.8).
5. Pure and total: never throws on valid input; invalid pointer types (arrays vs objects) simply do not match.
6. Matchers operate on already-tokenized args; add a guard that fails with `policy_raw_value_suspected` in tests if given an arg string containing a known canary (test helper only).
**Tests to write:** precedence table (deny over allow regardless of order); default decision; pointer edge cases; `tokenType`; wildcard tool patterns; property test: appending a `deny` rule never changes a `deny` into something less restrictive, and removing an `allow` rule never makes a call more permitted.
**Acceptance Criteria:**
- [ ] Most-restrictive-wins behavior verified by property tests.
- [ ] Evaluator is pure with no I/O.
- [ ] Explanations list every matching rule.

---

## 17.3 Run-loop integration: allow, ask, deny

**Parent:** #17 Policy engine and approvals
**Task Description:** Make the run loop consult the policy for every tool call before recording the intent, and act on the result.
**Expected Inputs:** Tokenized tool call, `PolicyPort`.
**Expected Output:** `PolicyPort` in `core/ports.ts`, `packages/policy/src/engine.ts` (`PolicyEngine implements PolicyPort`), updates to `tool-step.ts`, `createRuntime` wiring, `run_created.policyVersion` populated.
**Dependencies:** none.
**Items it depends on:** 17.2, 2.4, 2.9, 13.7.
**Implementation guidance:**
1. Order in the tool step: `toolPort.prepare(call)` (tokenizes args, 13.7) -> `policy.decide(preparedCall, ctx)` -> record `tool_intent` with `policyDecision` and `ruleId` -> act.
2. `deny`: record intent, then `tool_result` outcome `denied` with `errorCode` = rule reason; no execution; the model sees a denial result and can adapt.
3. `ask`: build the approval payload (17.4), call `requestApproval` (2.9), and return from the loop as suspended. After resolution, resume applies the decision (execute, edit, or deny). The recorded `policyDecision` remains `ask`.
4. `allow`: proceed to execute (detokenize inside the PII decorator).
5. Policy errors fail closed: any exception in `decide` records a denied result with `errorCode: "policy_error"`.
6. `PolicyEngine` loads the document once at startup, exposes `version`, and `createRuntime` passes it into `run_created`.
7. Decorator order documented in `createRuntime`: `Offloading( Pii( Policy( Tools ) ) )`.
**Tests to write:** fake tools: deny never executes; ask suspends and resumes; allow executes; policy exception fails closed; recorded events contain `policyDecision` and `ruleId`; crash-injection scenario (2.11) extended with an `ask` call.
**Acceptance Criteria:**
- [ ] No tool executes without a recorded policy decision.
- [ ] `ask` suspends the run durably.
- [ ] Policy failures fail closed.

---

## 17.4 Approval request payload schema and edit validation

**Parent:** #17 Policy engine and approvals
**Task Description:** Define the payload that approval UIs render and validate human edits against it.
**Expected Inputs:** Tool call, matched rule, tool input schema.
**Expected Output:** `packages/policy/src/approval-payload.ts` (`ApprovalPayload`, `buildApprovalPayload`, `validateEdits`).
**Dependencies:** none.
**Items it depends on:** 17.3, 2.9.
**Implementation guidance:**
1. `ApprovalPayload = { payloadVersion: 1, kind: "tool_call" | "resume_ambiguity", callId: Id, toolId: Code, args: JsonValue (tokenized), ruleId: Code, reason: Code, summary: string (max 500, built from a fixed template: "Tool <toolId> requests approval (rule <ruleId>)"), ui: { resourceUri: "ui://harness/approval/v1", fallbackText: string }, editableFields: JsonPointer[], expiresAt?: int }`. The payload is **content** (it contains tokenized args) and is recorded in `approval_requested.payload`.
2. `buildApprovalPayload` fills `editableFields` from the rule, `expiresAt` from `approvalTtlMs`, and `fallbackText` as a plain-text description (used by elicitation and CLI fallbacks).
3. `validateEdits(payload, edits, toolInputSchema)`: `edits` is `{ pointer: JsonPointer, value: JsonValue }[]`; every pointer must be inside `editableFields` (prefix match), else `edit_not_allowed`; apply to a deep copy of `args`; validate the result against the tool's input JSON schema (via the Zod schema when available or `ajv` for JSON Schema; verify which source the MCP bridge provides in 6.x) and fail with `edit_invalid` otherwise. Edited string values pass through the PII tokenizer (boundary `tool_input`) before being recorded.
4. For `resume_ambiguity` payloads `editableFields` is empty and decisions are `approve` (re-run) or `deny`.
**Tests to write:** build from a rule with editable fields; edits within and outside allowed pointers; invalid edit against schema; PII tokenization of edited values; fallback text deterministic; payload schema round trip.
**Acceptance Criteria:**
- [ ] Humans can only edit fields the policy marked editable.
- [ ] Edited arguments are validated and tokenized before use.
- [ ] Payload carries both UI resource and plain-text fallback.

---

## 17.5 CLI fallback: `harness approvals`

**Parent:** #17 Policy engine and approvals
**Task Description:** Let humans list and resolve approvals from the terminal.
**Expected Inputs:** Event store, resolver (vault) for optional reveal.
**Expected Output:** `packages/cli/src/commands/approvals.ts` (`list`, `show`, `approve`, `deny`), `docs/cli.md` section.
**Dependencies:** none.
**Items it depends on:** 17.4, 2.9, 12.7, 20.2.
**Implementation guidance:**
1. `harness approvals list [--run <id>]`: find suspended runs (`listRuns({ status: "suspended" })`), fold state, print pending approvals as a table: approvalId, runId, toolId, ruleId, age, expiry.
2. `harness approvals show <approvalId>`: metadata plus tokenized args (`--show-args` required for args); `--reveal` additionally resolves tokens through the auditing resolver with boundary `ui` and prints a stderr warning (explicit opt-in; audited).
3. `approve <approvalId> [--edit <json-file>]`: load payload, `validateEdits` if edits given, call `resolveApproval` (2.9) with decision `approve` or `edit`. `deny <approvalId>`: decision `deny`. Both support `--yes`; without it and on a TTY, prompt for confirmation.
4. Exit codes: 0 resolved, 1 failure, 2 usage, 7 `approval_not_found` or already resolved.
5. After resolving, print how to continue (`harness resume <runId>`); `--resume` flag optionally resumes immediately.
**Tests to write:** CLI tests with in-memory store: list output; show hides args by default; reveal audited (spy resolver) and warned; approve/deny/edit flows; double resolve exit code; confirmation prompt gating with a fake TTY.
**Acceptance Criteria:**
- [ ] A suspended run can be fully approved, edited, or denied from the CLI.
- [ ] Raw values only appear with `--reveal`, and each reveal is audited.
- [ ] Exit codes documented.

---

## 17.6 Expiry and escalation for pending approvals

**Parent:** #17 Policy engine and approvals
**Task Description:** Time out stale approvals and notify humans when they wait too long.
**Expected Inputs:** Pending approvals, TTL and escalation settings, clock, notifier.
**Expected Output:** `packages/policy/src/sweeper.ts` (`sweepApprovals`), `Notifier` port with `LogNotifier` and `WebhookNotifier`, schema change adding `reason?` and `decidedBy` to `approval_resolved`, CLI `harness approvals sweep`.
**Dependencies:** none.
**Items it depends on:** 17.5, 2.9.
**Implementation guidance:**
1. Schema: `approval_resolved.decidedBy: "human" | "policy" | "expiry"` (meta, required) and `reason?: Code` (meta). Update `classification.ts`, goldens, SafeEvent mapping (7.10), and `resolveApproval` callers.
2. `sweepApprovals({ store, clock, notifier })`: for every pending approval: if `now >= expiresAt` append `approval_resolved { decision: "deny", decidedBy: "expiry", reason: "expired" }`; else if the rule's `escalateAfterMs` has elapsed and no escalation was sent, call `notifier.notify` and remember it by appending nothing (track escalations in a small `approval_notifications` table keyed by `approvalId` in the event store DB, or in the control plane's local state; choose the table and add a migration).
3. `Notifier.notify({ runId, approvalId, toolId, ruleId, ageMs })` carries metadata only. `WebhookNotifier` posts JSON to a URL from a `SecretRef`, with a 5 s timeout, no retries beyond one, and never includes args. The webhook body is a Zod schema (`ApprovalNotification`) validated before sending (CONVENTIONS 3.10).
4. Sweeping is safe to run concurrently (resolve conflicts are tolerated: `approval_already_resolved` is ignored).
5. `harness approvals sweep` runs one sweep; the control plane (18.x) can call it periodically.
**Tests to write:** expiry at the boundary with fake clock; escalation sent exactly once; concurrent sweeps; webhook payload contains no args (canary); schema updates covered by exhaustiveness tests; expired approval leads to a denied result on resume.
**Acceptance Criteria:**
- [ ] Expired approvals deny automatically and are visible in the log.
- [ ] Escalation notifications are sent once and contain metadata only.
- [ ] Sweeper is idempotent and race-tolerant.

---

## 17.7 Decision audit: events, spans, and metrics

**Parent:** #17 Policy engine and approvals
**Task Description:** Make every policy decision and approval outcome observable in telemetry without content.
**Expected Inputs:** Decisions from 17.3 and 17.6.
**Expected Output:** `ruleId?: Code` added to `tool_intent`, span attributes `harness.policy.decision` (enum) and `harness.policy.rule_id` (code) on `harness.tool_call`, counter `harness.policy.decisions{decision}`, SafeEvent mapping updates, `METRIC_ALLOWLIST` entry (10.2), attribute catalog refresh.
**Dependencies:** none.
**Items it depends on:** 17.3, 17.6, 4.7, 10.2.
**Implementation guidance:**
1. Add `ruleId` to the `tool_intent` schema (meta) and to the safe `tool_call` projection (rule id is a Code authored by the operator, hence safe).
2. Register the new span attributes on `harness.tool_call` and the counter with its single enum attribute `decision` (`allow|ask|deny`); update `METRIC_ALLOWLIST` and regenerate the collector allowlist (10.2).
3. `approval_wait` safe projection includes `decidedBy` and `reason`.
4. Never include rule descriptions (free text) in telemetry.
5. Refresh `docs/telemetry/attribute-catalog.md` (4.7) and the golden files.
**Tests to write:** spans carry decision and rule id; counter attribute bounded to the enum; safe projection includes the new fields and nothing else (property test with canaries in descriptions); CI drift checks pass.
**Acceptance Criteria:**
- [ ] Dashboards can break down decisions by rule and outcome.
- [ ] No policy free text reaches telemetry.
- [ ] Catalog and collector allowlist regenerated and consistent.

---

## 17.8 `harness policy test` and `harness policy lint`

**Parent:** #17 Policy engine and approvals
**Task Description:** Give policy authors a dry-run, expectation-based regression tester and a linter.
**Expected Inputs:** Policy file, call fixtures, optional expectations.
**Expected Output:** `packages/cli/src/commands/policy.ts` (`test`, `lint`), `packages/policy/src/lint.ts`, `examples/policy-tests/`.
**Dependencies:** none.
**Items it depends on:** 17.2, 20.2.
**Implementation guidance:**
1. `harness policy test --policy <file> --calls <jsonl> [--expect <jsonl>] [--explain] [--json]`: each line `{ id, toolId, args, context? }`; prints decision, rule id, reason per call; with `--expect` (lines `{ id, decision, ruleId? }`) exits 1 on any mismatch and prints a diff.
2. `harness policy lint --policy <file>`: report errors for shadowed rules (a rule whose every match is already covered by a stricter earlier-matching rule), duplicate matchers, `allow` rules fully covered by `deny` rules, missing `reason`, overly broad `allow` (`fs.*` style wildcard with no arg matchers on tools marked destructive in tool metadata when available), and unused `editable` pointers. Errors exit 1, warnings exit 0.
3. Both commands work offline and never touch the store or models.
4. Provide `examples/policy-tests/` with a policy, calls, and expectations used by a CI step so the example policy cannot rot.
**Tests to write:** `policy test` pass and mismatch cases; lint detects each defect class on fixtures and passes the example policy; CI step test running the examples.
**Acceptance Criteria:**
- [ ] Policy changes can be regression-tested from a fixture file.
- [ ] Lint catches shadowed and over-broad rules.
- [ ] Example policy tests run in CI.

---

## 17.9 Approver identity and separation of duties

**Parent:** #17 Policy engine and approvals
**Task Description:** Record who requested each run and who resolved each approval, and optionally forbid people from approving runs they started.
**Expected Inputs:** Principals from the control plane, CLI, eval runner, and sweeper.
**Expected Output:** `packages/schemas/src/principal.ts` (`Principal`), schema changes: `run_created.requestedBy?: Code` and `approval_resolved.approverId?: Code` (meta, required when `decidedBy` is `human`), policy option `separationOfDuties`, enforcement in `resolveApproval` callers, invariant (f) in 22.6, docs `docs/policy.md` section "Who approved".
**Dependencies:** none.
**Items it depends on:** 17.6, 18.5, 12.8.
**Implementation guidance:**
1. Principals are Codes with a kind prefix: `token.<tokenId>` (control plane, 18.5), `cli.<name>` (CLI, from config `cli.principal` or `--as`), `eval.simulated` (16.6), `system.sweeper` (17.6). Document that CLI principals are attributable but not authenticated; deployments that need authenticated approvals use the control plane.
2. `requestedBy` is set when a run is created (CLI, SDK, control plane `start_run`). Subagents and continuations inherit the root run's `requestedBy`.
3. `separationOfDuties: true` on a rule (or `approvals.separationOfDuties: true` globally): resolving an approval for a run whose `requestedBy` equals the resolving principal fails with `approver_is_requester` (exit code 4 in the CLI). Expiry decisions are unaffected.
4. Telemetry: `approverId` and `requestedBy` are not part of the safe projection by default. With `telemetry.correlation.enabled` they may be exported only as pseudonyms (12.8).
5. Update `classification.ts`, `SafeEvent` mappings, goldens, and (after the first release) add upcasters per 7.13.
**Tests to write:** principal recorded for each path (CLI, control plane token, eval, sweeper); separation of duties rejection and acceptance; inheritance for subagents and continuations; approver ids absent from telemetry by default and pseudonymized when enabled (canary).
**Acceptance Criteria:**
- [ ] Every human approval records who decided.
- [ ] Separation of duties can be enforced per rule or globally.
- [ ] Identities reach telemetry only as opt-in pseudonyms.
