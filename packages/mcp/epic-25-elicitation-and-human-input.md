# Epic #25: Elicitation and human input

**Goal:** let MCP servers and the agent itself ask a human for information, safely and durably: MCP elicitation through Multi Round-Trip Requests (form and URL modes), compatibility with older servers, durable agent questions, relay to any connected MCP client, and MCP Apps UI, with the same audit, privacy, and approval-integrity guarantees as approvals. Read `docs/engineering/CONVENTIONS.md` first (especially section 10), plus epics 2 (suspension), 6 (MCP client), 13 (PII), 17 (approvals), and 18 (control plane).

**Tasks:** 25.1 to 25.8, all size S.

Shared design for this epic:

- **Protocol (MCP 2026-07-28).** Elicitation uses Multi Round-Trip Requests (MRTR). A server answers `tools/call` (or `resources/read`, `prompts/get`) with an `InputRequiredResult` (`resultType: "input_required"`) whose `inputRequests` map holds `elicitation/create` requests keyed by server-assigned ids, plus an optional opaque `requestState`. The client gathers the answers and **retries the original request** with a new JSON-RPC id, `inputResponses` (same keys; values `{ action: "accept" | "decline" | "cancel", content? }`), and the exact `requestState`. Form mode carries a flat `requestedSchema` of primitive properties; URL mode carries a `url`, and `accept` means consent only (the server learns the outcome on retry). Client capabilities (`elicitation: { form?, url? }`) travel in each request's `_meta`. The SDK v2 client is configured with `inputRequired: { autoFulfill: false }` so the harness drives every round itself.
- **Durable by construction.** Because the original request ends with `input_required`, nothing is held open: the harness records the request, suspends the run with reason `awaiting_input`, and retries the tool call after a human answers, even from a different process days later. `requestState` is stored encrypted as content, never inspected or modified (the spec forbids it), and echoed exactly.
- **Legacy servers (2025-11-25).** Older servers send server-initiated `elicitation/create` requests while holding the call open, and may use `URLElicitationRequiredError` (`-32042`) and `notifications/elicitation/complete`. These are supported through the SDK's legacy handling as a **live** path with a timeout (25.4); a crash during a live elicitation leaves a dangling tool call handled by the resume policy (2.5).
- **Three sources, one broker.** MCP server input requests (MRTR or legacy), and the agent's own `agent.ask_user` questions, all go through one `HumanInputBroker`, the same events, channels, and UI.
- **Servers are untrusted.** Messages and URLs are untrusted text shown to a human. Elicitation is off by default per server. The harness declares only `elicitation` (never the deprecated `sampling` or `roots`), declines forms that seek secrets, never opens or prefetches URLs, always shows which server is asking, and bounds rounds, sizes, and rates.
- **The model never answers.** Only humans (or the eval simulated human) resolve inputs. No model-visible tool can answer an input; the control plane's answer tools are app-only or gated by human confirmation (18.2).
- **Privacy.** Requests and answers are content and are recorded tokenized. An accepted form answer is sent to the requesting server raw (the human typed it for that server), in memory only, like detokenized tool arguments (13.5).
- **Layering.** `packages/mcp` handles the protocol and exposes an `ElicitationPort`; `packages/core` implements the broker and durable flows; the control plane, MCP Apps views, CLI, eval, and replay plug in as channels or recorders.

---

## 25.1 Input request schemas, events, and configuration

**Parent:** #25 Elicitation and human input
**Task Description:** Define the normalized input request, the form schema, the events, and the configuration that controls elicitation.
**Expected Inputs:** MCP 2026-07-28 elicitation and MRTR shapes; config.
**Expected Output:** `packages/schemas/src/human-input.ts` (`InputRequest`, `FormSchema`, `InputResponse`, `formSchemaToZod`), events `input_requested` and `input_resolved` in `events.ts`, `classification.ts` and `SafeEvent` mappings, config fragments `packages/schemas/src/config/elicitation.ts` and the per-server `elicitation` block in `servers.ts`, docs `docs/human-input.md`.
**Dependencies:** `zod` (4.2 or later).
**Items it depends on:** 7.1, 7.10, 6.1, 20.1, 17.9, 1.12.
**Implementation guidance:**

1. `FormSchema` (Zod) mirrors the MCP form subset exactly: a flat object whose properties are string (`minLength`, `maxLength`, `format` in `email|uri|date|date-time`, `default`), number or integer (`minimum`, `maximum`, `default`), boolean (`default`), single-select enum (`enum`, or `oneOf` of `{ const, title }`), and multi-select enum (array of enum strings or `anyOf` of `{ const, title }`, with `minItems`/`maxItems`), plus `required`. Accept `pattern` only from legacy servers and only when it passes the ReDoS screen. Unknown keywords and nesting are rejected (`input_schema_unsupported`). Limits: at most 20 properties, titles and descriptions at most 200 characters.
2. `formSchemaToZod(schema)` builds the Zod schema used to validate answers (CONVENTIONS 3.10), so answers are validated by Zod like every other contract.
3. `InputRequest = { requestId: Id, source: "mcp_mrtr" | "mcp_legacy" | "agent", serverId?: Code, callId?: Id, inputKey?: string (server-assigned key, max 128), round: int, mode: "form" | "url", message: string (max 2000), schema?: FormSchema, url?: string, expiresAt?: int }`.
4. Events:
   - `input_requested`: meta `requestId, source, serverId?, callId?, round, mode, expiresAt?`; content `inputKey, message, schema, url, requestState` (the opaque state is stored encrypted with other content and only ever echoed back).
   - `input_resolved`: meta `requestId, action (accept|decline|cancel), decidedBy (human|simulated|expiry|timeout|policy), approverId?, waitMs`; content `answer`.
   - `run_status_changed` gains reason `awaiting_input`; the state fold (2.1) tracks `pendingInputs` grouped by `callId` and round.
5. Safe projection: kind `input_wait { source, mode, round, action, decidedBy, waitMs }`. Messages, URLs, schemas, answers, and request state are never exported.
6. Config: per server `elicitation: { enabled: false, modes: ("form"|"url")[] (default ["form"]), maxRounds: 5, maxPerRun: 20, maxRequestStateBytes: 65536, legacyLiveTimeoutMs: 300000 }`; global `elicitation: { channels: ("control_plane"|"cli"|"app")[], urlAllowHosts?: string[], requireHttps: true, expiresAfterMs: 604800000 }`.
**Tests to write:** form schema accept and reject tables (every allowed keyword, titled enums, multi-select, nesting, unknown keywords, limits); `formSchemaToZod` validates answers for every field type; event round trips and classification exhaustiveness; safe projection contains no content (canary); config defaults (disabled).
**Acceptance Criteria:**

- [ ] The form schema accepts exactly the MCP subset within limits, and answers are validated with Zod.
- [ ] Input events are classified and projected without content.
- [ ] Elicitation is disabled unless configured per server.

---

## 25.2 MRTR client handling: durable input-required tool calls

**Parent:** #25 Elicitation and human input
**Task Description:** Handle `input_required` results from MCP servers by recording the requests, suspending the run, and retrying the original call with the answers.
**Expected Inputs:** `InputRequiredResult` from `tools/call` (and from `resources/read` for UI resources), configured servers.
**Expected Output:** `packages/mcp/src/elicitation/{mrtr.ts,validate.ts,sensitive.ts}`, `ElicitationPort`, per-request capability declaration in `connection.ts`, tool-step integration in `packages/core/src/steps/tool-step.ts`, resume handling in the resume planner (2.5), counters.
**Dependencies:** `@modelcontextprotocol/client` v2 (`ClientOptions.inputRequired: { autoFulfill: false }`, `allowInputRequired`, MRTR result types; verify names).
**Items it depends on:** 25.1, 6.2, 6.5, 2.5, 2.9.
**Implementation guidance:**

1. Capabilities: for servers with `elicitation.enabled`, declare `elicitation` with only the configured modes in each request's client capabilities. Never declare `sampling` or `roots`. An input request for an undeclared mode or method is a protocol violation: fail the tool call with `mcp_input_request_invalid`.
2. On `input_required`: validate every entry (`method` must be `elicitation/create`; schema per 25.1; message and URL limits; `requestState` size). Apply the sensitive-field guard: decline (do not ask the human) when a form property's name, title, or description matches the secret pattern from 20.3 (`password`, `token`, `secret`, `api key`, `credential`) or card and CVV terms, because the spec forbids secrets in form mode. Then record one `input_requested` per remaining key (round number, tokenized message, encrypted `requestState`), suspend the run with reason `awaiting_input`, and checkpoint. The `tool_intent` is already durable; no `tool_result` is written yet.
3. Retry: when every input for that call and round is resolved (or declined by the guard), re-issue the same tool call with a new request id, `inputResponses` (keys as received; validated answers, raw in memory only), and the exact stored `requestState`. A further `input_required` starts the next round, up to `maxRounds` (`mcp_input_rounds_exceeded` fails the call). The final result is recorded as the call's `tool_result`.
4. Resume (2.5): a dangling intent whose latest round has unresolved inputs stays suspended; one whose inputs are all resolved is retried with the stored responses and state; a crash after the retry was sent but before its result was recorded is treated like any dangling intent (idempotent tools retry, others escalate).
5. Limits: `maxPerRun` inputs per run per server; exceeding fails the call with `mcp_input_rate_limited`.
6. Counter `harness.mcp.input_requests{outcome}` (bounded enum: `asked|declined_sensitive|rejected|rounds_exceeded|rate_limited`); never label with server ids. Update `METRIC_ALLOWLIST`.
**Tests to write:** in-memory server and client pair on 2026-07-28: capability declared only when enabled; one round and multi-round flows end to end (suspend, resolve from another process, retry with exact `requestState`, complete); sensitive-field decline; undeclared method rejected; round and rate limits; crash at each point (after intent, after `input_requested`, after resolution, after retry sent) resumes correctly with exactly-once side effects for a non-idempotent tool; server text never reaches logs or spans (canary); `requestState` is byte-identical on retry.
**Acceptance Criteria:**

- [ ] MCP input requests suspend the run durably and resume across processes.
- [ ] Retries echo answers and `requestState` exactly, within round limits.
- [ ] Secret-seeking and malformed requests never reach a human.

---

## 25.3 Human input broker and channels

**Parent:** #25 Elicitation and human input
**Task Description:** Implement the broker that presents recorded input requests to humans through available channels, validates answers, and resolves them.
**Expected Inputs:** Pending `input_requested` events, channel registrations.
**Expected Output:** `packages/core/src/human-input/{broker.ts,channels.ts,resolve.ts}`, `HumanInputChannel` interface, `resolveInput` standalone function, `harness.input_wait` span, docs update.
**Dependencies:** none.
**Items it depends on:** 25.2, 2.2, 13.4, 13.5, 17.9.
**Implementation guidance:**

1. Messages and string defaults are tokenized (boundary `ui`) before `input_requested` is recorded, so the human view never shows raw values a server echoed.
2. Channels: `interface HumanInputChannel { id: Code; available(req): boolean; present(req, signal): Promise<InputResponse & { principal: Code }> }`. Built-ins: CLI interactive prompt (`harness run --interactive` on a TTY), control-plane relay (25.6), and the MCP Apps input view (25.7). Pending inputs are always listable, so a human can answer later even when no channel is live.
3. `resolveInput(store, runId, requestId, { action, answer?, principal })` works without a live process: verify the input is pending, validate the answer with `formSchemaToZod`, tokenize it (boundary `tool_input`, destination `{ tool: <calling tool> }` or `any` for agent questions), append `input_resolved`, and enqueue a resume when a queue is configured (24.3). Separation of duties (17.9) applies when configured.
4. Expiry: the sweeper (17.6) resolves inputs older than `expiresAfterMs` with `action: "cancel"`, `decidedBy: "expiry"`.
5. The span `harness.input_wait` carries `source`, `mode`, `round`, `action`, and `harness.wait_ms` only.
**Tests to write:** tokenized message before display; first channel answer wins and other channels are cancelled; resolve from a different process; schema validation errors re-ask once; double resolution rejected; expiry; raw answer never recorded (canary); span attributes registered.
**Acceptance Criteria:**

- [ ] Every human input records request, outcome, approver, and wait time.
- [ ] Answers are validated with Zod before they reach a server or the model.
- [ ] Inputs can be answered from any process, at any later time.

---

## 25.4 URL mode and legacy-server compatibility

**Parent:** #25 Elicitation and human input
**Task Description:** Support URL-mode elicitation with the spec's URL safety rules, and support 2025-11-25 servers (live server-initiated elicitation, `-32042`, and completion notifications) through the SDK's legacy handling.
**Expected Inputs:** URL-mode input requests; legacy server requests and errors.
**Expected Output:** `packages/mcp/src/elicitation/{url.ts,legacy.ts}` (`checkElicitationUrl`, legacy live handler), legacy `-32042` handling in `tool-port.ts`.
**Dependencies:** `@modelcontextprotocol/client` v2 legacy-era support (verify how the client surfaces server-initiated `elicitation/create` on 2025-era connections).
**Items it depends on:** 25.3, 2.5.
**Implementation guidance:**

1. `checkElicitationUrl(url)`: must parse; `https` required unless the host is loopback and `requireHttps` is false; reject `javascript:`, `data:`, `file:`, credentials in the URL, and IP-literal hosts unless allowlisted; flag punycode and mixed-script hosts as `suspicious` (shown as a warning); optional `urlAllowHosts`. Rejected URLs are answered `decline` without asking a human.
2. The harness never fetches, prefetches, or opens the URL. Channels show the full URL with the registrable domain highlighted and the requesting server, and open it only after explicit consent in the human's own browser (CLI prints it; MCP Apps hosts open it through the gated open-link request, 3.8; the control plane relays it to URL-capable clients).
3. MRTR URL mode: `accept` records consent; the retry (25.2) lets the server decide whether the out-of-band step finished, possibly returning another round. Channels offer "I'm done" (retry now) and "cancel" controls, as the spec recommends.
4. Legacy live path (2025-era connections, `source: "mcp_legacy"`): a server-initiated elicitation is accepted only while a tool call to that server is in flight and is bound to it (serialize calls to elicitation-enabled legacy servers if correlation is otherwise ambiguous). Record `input_requested`, wait up to `legacyLiveTimeoutMs` for a channel answer, record `input_resolved` (`decidedBy: "timeout"` on expiry), and answer the server. Legacy `-32042` errors become a durable flow like MRTR: record the URL inputs, suspend, and on resolution retry the call (idempotent tools retry; others need an approval first). Ignore `notifications/elicitation/complete` for unknown ids; matching ones allow an immediate retry.
**Tests to write:** URL checker table (schemes, credentials, IP literals, punycode warning, allowlist); no network activity in the harness process during URL handling (intercepting dispatcher); MRTR URL round with "done" and "cancel"; legacy live elicitation answered, timed out, and outside a call (cancelled); legacy `-32042` suspend and retry; legacy completion notification handling.
**Acceptance Criteria:**

- [ ] URLs are shown in full, checked, and opened only with consent, never by the harness.
- [ ] 2025-11-25 servers work through the live path with bounded waits.
- [ ] URL-required errors from legacy servers are durable and retried safely.

---

## 25.5 Durable `agent.ask_user` tool

**Parent:** #25 Elicitation and human input
**Task Description:** Let the agent ask the human a question, optionally with a form, suspending the run until answered.
**Expected Inputs:** `agent.ask_user { question, schema?, expiresInMs? }` tool calls.
**Expected Output:** `packages/core/src/builtin/ask-user-tool.ts` (Zod input and output schemas per CONVENTIONS 3.10), resume application, example policy rule.
**Dependencies:** none.
**Items it depends on:** 25.3, 2.9, 17.6, 23.2.
**Implementation guidance:**

1. Input: `question` (max 2000), optional `schema: FormSchema`, `expiresInMs` (max 7 days). The tool needs no approval by default (`examples/policy.yaml`: `allow`); operators can set `ask` or `deny`.
2. Flow: record `tool_intent`, `input_requested { source: "agent", callId, round: 1 }`, then `running -> suspended` with reason `awaiting_input`, checkpoint, and return suspended (like 2.9).
3. Resume delivers the outcome as the tool's `tool_result`: `accept` returns `{ action: "accept", answer }` (tokenized), `decline` and `cancel` return the action only.
4. Subagents: a child's question suspends the child and the parent (`awaiting_subagent`, 23.2); the pending input is listed with the child's run id.
**Tests to write:** ask, suspend, resolve from another process, resume, and receive the answer; decline and cancel; schema-validated answers; expiry via the sweeper; child question surfaces through the parent; the model cannot resolve its own question (invariant (g) in 22.6).
**Acceptance Criteria:**

- [ ] The agent can ask a question and the run waits durably for the answer.
- [ ] Answers are validated, tokenized, and attributed to a human.
- [ ] Expired questions resolve as cancelled.

---

## 25.6 Control-plane relay, input tools, and CLI

**Parent:** #25 Elicitation and human input
**Task Description:** Let humans answer inputs from any MCP client and from the terminal, relaying pending inputs to connected clients with the server-side MRTR API.
**Expected Inputs:** Pending inputs, connected client requests and their per-request capabilities.
**Expected Output:** `packages/control-plane/src/tools/{list-pending-inputs.ts,get-input.ts,answer-input.ts,review-input.ts}`, CLI `packages/cli/src/commands/inputs.ts` (`list`, `show`, `answer`, `decline`), `harness run --interactive`, docs updates in `docs/cli.md` and `docs/control-plane-clients.md`.
**Dependencies:** `@modelcontextprotocol/server` v2 (`inputRequired`, `inputRequired.elicit`, `acceptedContent`, `createRequestStateCodec`; verify names).
**Items it depends on:** 25.4, 25.5, 18.2, 18.5, 18.7, 20.2.
**Implementation guidance:**

1. `list_pending_inputs` (scope `read`) returns metadata: request id, run id, source, mode, server id, round, age, expiry. `get_input` (scope `approve`) returns the tokenized message and schema. `answer_input { requestId, action, answer? }` (scope `approve`) is app-only or behind the confirmation gate (18.2).
2. `review_input { requestId }` (model-visible, safe because a human decides) returns an `InputRequiredResult` that re-asks the same form (or URL) as an `elicitation/create` addressed to the human at the connected client, naming the original server and run in the message; the `requestState` is sealed with `createRequestStateCodec`, bound to the token, request id, and a short expiry, and single-use. The retry carrying the human's answer resolves the input through `resolveInput`. Clients without the needed elicitation mode get text instructions instead.
3. CLI: `harness inputs list`, `show <id>` (message hidden behind `--show-message`), `answer <id> [--json <file>]` with an interactive form on a TTY (each property with its type, default, and constraints; review before submit), and `decline <id>`. URL inputs print the full URL with the domain highlighted and require confirmation. Exit code 7 for unknown or already-resolved inputs.
4. `harness run --interactive` registers the CLI channel so inputs during a local run are answered in the terminal right away.
5. Every answer records the principal (17.9).
**Tests to write:** tool scopes and run filters; `review_input` round trip on a 2026-07-28 client and on a 2025-era client (SDK legacy shim); sealed state rejected when tampered, expired, replayed, or presented by another token; clients without elicitation get instructions; CLI list, show, answer, and decline with a fake TTY; exit codes; no message or answer in logs (canary).
**Acceptance Criteria:**

- [ ] Humans can answer inputs from MCP clients, MCP Apps views, and the CLI.
- [ ] Relayed elicitations are bound, single-use, and expire.
- [ ] Answers always record who answered.

---

## 25.7 Input view as an MCP App

**Parent:** #25 Elicitation and human input
**Task Description:** Render input requests as an MCP App with the same security and accessibility bar as approvals.
**Expected Inputs:** `InputRequest` payloads via the bridge.
**Expected Output:** view `packages/approval-app/src/views/input/` built with the shared kit (5.7), resource `ui://harness/input/v1` served by the control plane and linked from `list_pending_inputs` and `get_input` via `_meta.ui.resourceUri`, app-only tool `harness.inputs.answer`, shared schemas in `packages/schemas/src/approval-tools.ts`, console and run-inspector badges "needs input" (18.3, 18.8).
**Dependencies:** `@modelcontextprotocol/ext-apps` (`App` class).
**Items it depends on:** 25.6, 5.4, 5.7, 3.8, 18.3.
**Implementation guidance:**

1. Show the requesting server id (or "the agent") prominently, the tokenized message with tokens as pills, and a form generated from `FormSchema` with real labels, types, defaults pre-filled, and client-side validation (the same `formSchemaToZod`). The human can review and change every field before submitting. Accept, Decline, and Cancel are separate buttons.
2. URL mode: show the full URL as text (never a clickable link inside the message), highlight the registrable domain, warn on suspicious hosts, and open it only through the host's gated open-link request after explicit confirmation; then offer "I'm done" and "Cancel".
3. Same rules as 5.3 and 5.7: `textContent` only, single-file build, no external URLs, axe checks, 320 px support, host theme and display modes.
4. Telemetry: register `ui.input` with an `action` enum only (host side, 3.4).
**Tests to write:** jsdom rendering for every field type and constraint; XSS in message, titles, and enum labels renders as text; URL never clickable in the message and opened only after confirmation; decline and cancel; axe checks; build-output URL scan.
**Acceptance Criteria:**

- [ ] Every allowed form field type renders and validates.
- [ ] URL handling meets the spec's client requirements.
- [ ] The view passes the same security and accessibility checks as the approval app.

---

## 25.8 Eval, replay, and hostile-server tests for human input

**Parent:** #25 Elicitation and human input
**Task Description:** Make human input deterministic in evals and replay, and prove the elicitation path holds against malicious servers and injected instructions.
**Expected Inputs:** Eval suites, recorded logs, hostile server fixtures.
**Expected Output:** `HumanScript.inputs` rules in `packages/eval/src/human.ts`, replay serving of recorded inputs in `packages/replay/src/ports/replay-human.ts`, sample server tools `confirm_action` (form, MRTR), `connect_account` (URL, MRTR), and legacy variants in `test/fixtures/sample-mcp-server`, `test/fixtures/hostile-elicitation-server/`, `test/elicitation.int.test.ts`, red-team and prompt-injection additions.
**Dependencies:** none.
**Items it depends on:** 25.4, 25.5, 16.6, 9.2, 6.7, 22.5.
**Implementation guidance:**

1. Simulated human: `inputs: { match: { source?, serverId?, mode? }, action, answer?: JsonValue }[]` with a `default` action (`decline`); answers are validated like real ones; reports count inputs by action.
2. Replay: input rounds replay from recorded `input_requested` and `input_resolved` events through `resolveInput`; the replay tool port returns the recorded final `tool_result` and verifies the recorded rounds match. Diffs (9.4) include `input_wait` safe events.
3. Hostile server fixture (both protocol eras): password and card fields in form mode; nested and oversized schemas; ReDoS patterns; input requests for undeclared methods (`sampling/createMessage`, `roots/list`); oversized `requestState`; endless rounds; floods; legacy elicitation with no active call; `javascript:`, `data:`, credential-bearing, and punycode URLs; a message with instructions aimed at the human or the model; a message echoing a canary value.
4. Assertions: every hostile behavior is declined, rejected, bounded, or flagged as specified; counters match; no canary reaches telemetry, logs, or unintended events; `requestState` is never modified; the obedient model (22.5) cannot answer an input through any model-visible tool; invariant (g) in 22.6 holds for every trial.
5. Add red-team tasks (22.6) for self-answering and for using elicitation messages to steer approvals.
**Tests to write:** the integration suite above in the `integration` stage; eval tasks with scripted inputs in replay mode; replay determinism for multi-round inputs; red-team additions in the `gates` stage.
**Acceptance Criteria:**

- [ ] Evals and replays handle human input deterministically.
- [ ] Every hostile elicitation behavior is contained and counted, on both protocol eras.
- [ ] No model-visible path can answer a human input.
