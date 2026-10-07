# Epic #25: Elicitation and human input

**Goal:** let MCP servers and the agent itself ask a human for information through MCP elicitation, safely: form and URL modes, the URL-elicitation-required error, durable agent questions, relay to any connected MCP client, and the same audit, privacy, and approval-integrity guarantees as approvals. Read `docs/engineering/CONVENTIONS.md` first, plus epics 2 (suspension), 6 (MCP client), 13 (PII), 17 (approvals), and 18 (control plane).

**Tasks:** 25.1 to 25.8, all size S.

Shared design for this epic:
- **Protocol.** Elicitation follows the MCP specification revision `2025-11-25` (verify against the pinned SDK): servers send `elicitation/create` with `mode` `form` (flat `requestedSchema` of primitive properties) or `url` (`url` plus `elicitationId`). Clients answer with `action` `accept`, `decline`, or `cancel`. URL mode may end with `notifications/elicitation/complete`, and servers may return `URLElicitationRequiredError` (`-32042`). Clients declare `capabilities.elicitation` with the modes they support. Use the SDK's request and notification schemas and helpers (for example `ElicitRequestSchema` and the client's request handler API; verify names) rather than hand-written JSON-RPC.
- **Three sources, one broker.**
  - *Live server elicitation*: arrives during an MCP `tools/call`. The server holds the request open, so it cannot survive a process crash. The harness waits with a timeout; if the process dies, the tool call is a dangling intent handled by the resume policy (2.5).
  - *URL elicitation required*: the server ends the tool call with `-32042`. This is durable: the run suspends with reason `awaiting_input` and the call is retried after the human completes the URL flow.
  - *Agent question* (`agent.ask_user`): the model asks the human. This is durable: the run suspends like an approval (2.9).
  All three go through one `HumanInputBroker` and the same events, channels, and UI.
- **Servers are untrusted.** Messages, titles, and URLs are untrusted text shown to a human. Elicitation is off by default per server. The harness never sends sensitive data in form mode, never opens or prefetches URLs, always shows which server is asking, and rate-limits requests.
- **The model never answers.** Only humans (or the eval simulated human) resolve inputs. No model-visible tool can answer an elicitation or an `agent.ask_user` question; the control plane's answer tools are app-only or gated by human confirmation, like approvals (18.2).
- **Privacy.** Requests and answers are content: they are recorded tokenized. An accepted form answer is sent to the requesting server raw (the human typed it for that server), in memory only, like detokenized tool arguments (13.5).
- **Layering.** `packages/mcp` handles the protocol and exposes an `ElicitationPort` callback. `packages/core` implements the broker and the durable flows. The control plane, approval app, CLI, eval, and replay plug in as channels or recorders.

---

## 25.1 Input request schemas, events, and configuration

**Parent:** #25 Elicitation and human input
**Task Description:** Define the normalized input request, the restricted form schema, the two new event types, and the configuration that controls elicitation.
**Expected Inputs:** MCP elicitation request shapes; config.
**Expected Output:** `packages/schemas/src/human-input.ts` (`InputRequest`, `FormSchema`, `InputResponse`), events `input_requested` and `input_resolved` in `events.ts`, `classification.ts` and `SafeEvent` mappings, config fragments `packages/schemas/src/config/elicitation.ts` and the per-server `elicitation` block in `servers.ts`, docs `docs/human-input.md`.
**Dependencies:** `zod`.
**Items it depends on:** 7.1, 7.10, 6.1, 20.1, 17.9.
**Implementation guidance:**
1. `FormSchema` mirrors the MCP form subset exactly: a flat object whose properties are string (`minLength`, `maxLength`, `pattern`, `format` in `email|uri|date|date-time`, `default`), number or integer (`minimum`, `maximum`, `default`), boolean (`default`), single-select enum (`enum` or `oneOf` of `{ const, title }`), and multi-select enum (array of enum strings with `minItems`/`maxItems`), plus `required`. Unknown keywords and nesting are rejected (`input_schema_unsupported`). Limits: at most 20 properties, titles and descriptions at most 200 characters, `pattern` passes the shared ReDoS screen.
2. `InputRequest = { requestId: Id, source: "mcp_server" | "agent" | "url_required", serverId?: Code, callId?: Id, mode: "form" | "url", message: string (max 2000), schema?: FormSchema, url?: string, elicitationId?: string (max 128), expiresAt?: int }`.
3. Events:
   - `input_requested`: meta `requestId, source, serverId?, callId?, mode, expiresAt?`, content `message, schema, url`.
   - `input_resolved`: meta `requestId, action (accept|decline|cancel), decidedBy (human|simulated|expiry|timeout|policy), approverId?, waitMs`, content `answer`.
   - `input_completed`: meta `requestId` only; records a URL-mode completion notification (25.4).
   - `run_status_changed` gains reason `awaiting_input`; the run state fold (2.1) tracks `pendingInputs` like `pendingApprovals`.
4. Safe projection: kind `input_wait { source, mode, action, decidedBy, waitMs }`. Messages, URLs, schemas, and answers are never exported.
5. Config: per server `elicitation: { enabled: false, modes: ("form"|"url")[] (default ["form"]), timeoutMs: 300000, maxPerCall: 5, maxPerRun: 20, onUnavailable: "decline" | "cancel" (default "cancel") }`; global `elicitation: { channels: ("control_plane"|"cli"|"app")[], urlAllowHosts?: string[], requireHttps: true }`.
**Tests to write:** form schema accept and reject tables (every allowed keyword, nesting, unknown keywords, limits, unsafe pattern); event round trips and classification exhaustiveness; safe projection contains no content (canary); config defaults (disabled).
**Acceptance Criteria:**
- [ ] The form schema accepts exactly the MCP subset within limits.
- [ ] Input events are classified and projected without content.
- [ ] Elicitation is disabled unless configured per server.

---

## 25.2 MCP client elicitation handler (form mode)

**Parent:** #25 Elicitation and human input
**Task Description:** Advertise elicitation per server and handle `elicitation/create` form requests from MCP servers safely.
**Expected Inputs:** Requests from connected servers during tool calls.
**Expected Output:** `packages/mcp/src/elicitation/{handler.ts,validate.ts,sensitive.ts}`, `ElicitationPort` interface, capability negotiation in `connection.ts`, counters.
**Dependencies:** `@modelcontextprotocol/sdk` client request handlers (verify `setRequestHandler` with the elicitation request schema, and how a server request is correlated to the in-flight `tools/call`).
**Items it depends on:** 25.1, 6.2, 6.5.
**Implementation guidance:**
1. Capabilities: declare `elicitation` only for servers with `elicitation.enabled`, and only the configured modes (`{ form: {} }` and/or `{ url: {} }`). A request in an undeclared mode is answered with JSON-RPC `-32602`.
2. Correlation: an elicitation is accepted only while a `tools/call` to that server is in flight, and is bound to that call's `runId` and `callId`. Use the SDK's related-request information if available (verify); otherwise serialize calls to elicitation-enabled servers (one in-flight call per server connection) so correlation is unambiguous. Requests with no in-flight call are answered `cancel` and counted (`no_active_call`).
3. Validation: parse `requestedSchema` with `FormSchema` (25.1); invalid schemas are answered `decline` with counter reason `schema`.
4. Sensitive-field guard: the spec forbids servers from requesting secrets in form mode. Decline (counter reason `sensitive_field`) when a property name, title, or description matches the secret pattern from 20.3 (`password`, `token`, `secret`, `api key`, `credential`) or card and CVV terms. Log the code only.
5. Limits: per call and per run caps from config; exceeding answers `cancel` (`rate_limited`).
6. Hand valid requests to `ElicitationPort.request(InputRequest, { signal })`, which the core implements (25.3). Map the result to the MCP response: `accept` with `content`, `decline`, or `cancel`. Abort (tool timeout or run cancel) answers `cancel`.
7. Counter `harness.mcp.elicitations{outcome}` (bounded enum: `accepted|declined|cancelled|rejected`); never label with server ids. Update `METRIC_ALLOWLIST`.
**Tests to write:** in-memory server and client pair: capability declared only when enabled; undeclared mode returns `-32602`; valid form round trip through a fake port; schema rejection; sensitive-field decline; no active call; per-call and per-run limits; abort answers cancel; server text never reaches logs or spans (canary).
**Acceptance Criteria:**
- [ ] Only enabled servers can elicit, and only in declared modes.
- [ ] Secret-seeking and malformed forms are declined.
- [ ] Every elicitation is bound to one in-flight tool call.

---

## 25.3 Human input broker and live channels

**Parent:** #25 Elicitation and human input
**Task Description:** Implement the broker that records input requests, routes them to a human through available channels, validates answers, and returns them, for live server elicitations.
**Expected Inputs:** `InputRequest` from the MCP handler, channel registrations.
**Expected Output:** `packages/core/src/human-input/{broker.ts,channels.ts,validate-answer.ts}`, `HumanInputChannel` interface, recording through `RunRecorder`, `harness.input_wait` span, docs update.
**Dependencies:** none.
**Items it depends on:** 25.2, 2.2, 13.4, 13.5, 17.9.
**Implementation guidance:**
1. `HumanInputBroker.request(req, ctx)`: tokenize `message` and string defaults (boundary `ui`) so the human view never shows raw values the server echoed; record `input_requested` (content tokenized) through the recorder; offer the request to registered channels; await the first answer or the timeout; validate the answer against the schema; record `input_resolved`; return the answer.
2. Channels: `interface HumanInputChannel { id: Code; available(req): boolean; present(req, signal): Promise<InputResponse & { principal: Code }> }`. Built-ins: CLI interactive prompt (when `harness run --interactive` runs on a TTY), control-plane relay (25.6), and the app view (25.7). When no channel is available, answer per `onUnavailable` and record `decidedBy: "policy"`.
3. Answers: validate with the form schema (`input_answer_invalid` lets the channel re-ask once). The recorded `answer` is tokenized with boundary `tool_input` and destination `{ tool: <the calling tool id> }`; the raw answer goes back to the MCP handler in memory only. Record an audit `pii_action` when values were tokenized.
4. Live requests that time out record `decidedBy: "timeout"` and answer `cancel`. Document that a crash during a live elicitation leaves the tool call dangling (2.5 applies; the server may ask again on re-run).
5. The span `harness.input_wait` carries `source`, `mode`, `action`, `harness.wait_ms` only.
**Tests to write:** request recorded before any channel sees it; first channel answer wins and others are cancelled; schema validation and one re-ask; timeout and unavailable paths; raw answer never recorded (canary in answer); server message containing a raw value is tokenized before display; span attributes registered.
**Acceptance Criteria:**
- [ ] Every human input is recorded with request, outcome, approver, and wait time.
- [ ] Answers are validated before reaching a server.
- [ ] Raw answers exist only in memory on the way to the server.

---

## 25.4 URL mode, URL-elicitation-required errors, and completion

**Parent:** #25 Elicitation and human input
**Task Description:** Support URL-mode elicitation and the `-32042` error with the spec's URL safety rules, making the error path durable.
**Expected Inputs:** URL-mode requests, `URLElicitationRequiredError` results, `notifications/elicitation/complete`.
**Expected Output:** `packages/mcp/src/elicitation/url.ts` (`checkElicitationUrl`), handling of `-32042` in `tool-port.ts`, completion tracking, durable suspension path in `packages/core/src/human-input/url-required.ts`.
**Dependencies:** SDK error and notification schemas for URL elicitation (verify names).
**Items it depends on:** 25.3, 2.9, 2.5.
**Implementation guidance:**
1. `checkElicitationUrl(url)`: must parse; `https` required unless the host is loopback and `requireHttps` is false; reject `javascript:`, `data:`, `file:`, credentials in the URL, and IP-literal hosts unless allowlisted; flag punycode and mixed-script hosts as `suspicious` (shown as a warning); optional `urlAllowHosts` restricts hosts. Rejected URLs are answered `decline`.
2. The harness never fetches, prefetches, or opens the URL. Channels show the full URL with the registrable domain highlighted and the requesting server id, and open it only after explicit consent, in the human's own browser (CLI prints it; the app asks the host to open it; the control plane relays it to a URL-capable client).
3. Live URL elicitation: `accept` means consent only. Track `elicitationId` per server connection. A matching `notifications/elicitation/complete` appends `input_completed { requestId }` (25.1). Unknown or already-completed ids are ignored, as the spec requires.
4. `-32042` durable path: the tool call ends; record `tool_result` outcome `error`, `errorCode: "mcp_url_elicitation_required"`; record one `input_requested { source: "url_required" }` per listed elicitation; suspend the run with reason `awaiting_input` and checkpoint. When the human marks it done (or the completion notification arrives while connected), resolve the input; on resume, re-run the tool call if it is idempotent, otherwise create an approval (`kind: "resume_ambiguity"`, 2.5) before re-running.
**Tests to write:** URL checker table (schemes, credentials, IP literals, punycode warning, allowlist); never-fetch assertion (no network activity in the harness process during URL handling, via an intercepting dispatcher); live URL flow with completion notification; unknown completion ignored; `-32042` suspends, resumes, and retries an idempotent tool; non-idempotent tool requires approval before retry.
**Acceptance Criteria:**
- [ ] URLs are shown in full, checked, and opened only with consent, never by the harness.
- [ ] `-32042` errors suspend the run durably and retry safely.
- [ ] Completion notifications are matched to their requests.

---

## 25.5 Durable `agent.ask_user` tool

**Parent:** #25 Elicitation and human input
**Task Description:** Let the agent ask the human a question, optionally with a form, suspending the run until answered.
**Expected Inputs:** `agent.ask_user { question, schema?, expiresInMs? }` tool calls.
**Expected Output:** `packages/core/src/builtin/ask-user-tool.ts`, `resolveInput` standalone function in `packages/core/src/human-input/resolve.ts`, resume application, sweeper support for input expiry, example policy rule.
**Dependencies:** none.
**Items it depends on:** 25.3, 2.9, 17.6, 23.2.
**Implementation guidance:**
1. Schema: `question` (max 2000), optional `schema: FormSchema`, `expiresInMs` (max 7 days). The tool is non-idempotent for resume purposes but needs no approval by default (`examples/policy.yaml`: `allow`); operators can set `ask` or `deny`.
2. Flow: record `tool_intent`, `input_requested { source: "agent", callId }`, then `running -> suspended` with reason `awaiting_input`, checkpoint, and return suspended (like 2.9).
3. `resolveInput(store, runId, requestId, { action, answer?, principal })` works without a live process: verify pending, validate the answer, tokenize it (boundary `tool_input`, destination `any`), append `input_resolved`. Separation of duties (17.9) applies when configured.
4. Resume delivers the outcome as the tool's `tool_result`: `accept` returns `{ action: "accept", answer }` (tokenized), `decline` and `cancel` return the action only.
5. Expiry: the sweeper (17.6) also resolves expired inputs with `action: "cancel"`, `decidedBy: "expiry"`.
6. Subagents: a child's question suspends the child and the parent (`awaiting_subagent`, 23.2); the pending input is listed with the child's run id.
**Tests to write:** ask, suspend, resolve from another process, resume, and receive the answer; decline and cancel; schema-validated answers; expiry via the sweeper; child question surfaces through the parent; the model cannot resolve its own question (no model-visible path; invariant (g) in 22.6).
**Acceptance Criteria:**
- [ ] The agent can ask a question and the run waits durably for the answer.
- [ ] Answers are validated, tokenized, and attributed to a human.
- [ ] Expired questions resolve as cancelled.

---

## 25.6 Control-plane relay, input tools, and CLI

**Parent:** #25 Elicitation and human input
**Task Description:** Let humans answer inputs from any MCP client and from the terminal, relaying live elicitations to connected clients through the SDK's server-side elicitation.
**Expected Inputs:** Pending inputs, connected client sessions and their capabilities.
**Expected Output:** `packages/control-plane/src/tools/{list-pending-inputs.ts,answer-input.ts}`, `packages/control-plane/src/elicitation-relay.ts` (a `HumanInputChannel`), CLI `packages/cli/src/commands/inputs.ts` (`list`, `show`, `answer`, `decline`), `harness run --interactive`, docs updates in `docs/cli.md` and `docs/control-plane-clients.md`.
**Dependencies:** `@modelcontextprotocol/sdk` server-side elicitation (verify the server API for form and URL modes, for example `elicitInput`).
**Items it depends on:** 25.4, 25.5, 18.2, 18.5, 18.7, 20.2.
**Implementation guidance:**
1. `list_pending_inputs` (scope `read`) returns metadata: request id, run id, source, mode, server id, age, expiry. `get_input` (scope `approve`) returns the tokenized message and schema. `answer_input { requestId, action, answer? }` (scope `approve`) is app-only or behind the confirmation gate (18.2); the answer is the human's own input, so the elicitation that collects it doubles as the confirmation.
2. Relay channel: for a pending input, pick connected sessions whose token can act on the run and whose client declared the needed elicitation mode. Send a server-side elicitation (form with the same schema, or URL) whose message names the requesting MCP server and run. The first accepted answer wins; other relays are cancelled. Clients without elicitation see the input in `list_pending_inputs` and the console.
3. CLI: `harness inputs list`, `show <id>` (message hidden behind `--show-message`), `answer <id> [--json <file>]` with an interactive form on a TTY (renders each property with its type, default, and constraints), and `decline <id>`. URL inputs print the full URL with the domain highlighted and ask for confirmation before printing it as openable. Exit code 7 for unknown or already-resolved inputs.
4. `harness run --interactive` registers the CLI channel so live elicitations during a local run are answered in the terminal.
5. Every answer records the principal (17.9).
**Tests to write:** tool scopes and run filters; relay to a fake elicitation-capable client (form and URL), first answer wins; clients without elicitation fall back to tools; CLI list, show, answer, and decline with a fake TTY; interactive run answering a live elicitation; exit codes; no message or answer in logs (canary).
**Acceptance Criteria:**
- [ ] Humans can answer inputs from MCP clients, the console, and the CLI.
- [ ] Live elicitations reach a connected human client when one exists.
- [ ] Answers always record who answered.

---

## 25.7 Input view in the approval app and console

**Parent:** #25 Elicitation and human input
**Task Description:** Render input requests in the MCP App UI with the same security and accessibility bar as approvals.
**Expected Inputs:** `InputRequest` payloads via the host bridge.
**Expected Output:** `packages/approval-app/src/input-view.ts` and form renderer, resource `ui://harness/input/v1` served by the control plane, console badge "needs input" (18.3), app-only tool `harness.inputs.answer`, shared schemas in `packages/schemas/src/approval-tools.ts`.
**Dependencies:** `@modelcontextprotocol/ext-apps` (verify the host request for opening links, for example an open-link method).
**Items it depends on:** 25.6, 5.4, 5.5, 18.3.
**Implementation guidance:**
1. The view shows the requesting server id or "the agent" prominently, the tokenized message (tokens as pills, 5.3), and a form generated from `FormSchema` with real labels, types, defaults pre-filled, and client-side validation. The human can review and change every field before submitting. Accept, Decline, and Cancel are separate buttons.
2. URL mode: show the full URL as text (never a clickable link inside the message), highlight the registrable domain, show a warning for suspicious hosts, and open it only through the host's open-link request after an explicit confirmation.
3. Same rules as 5.3: `textContent` only, single-file build, no external URLs in the bundle, axe checks, 320 px support.
4. Telemetry: `ui.decision` gets a sibling span `ui.input` with `action` enum only (register through the host, 3.4).
**Tests to write:** jsdom rendering for every field type and constraint; XSS in message, titles, and enum labels renders as text; URL never clickable in the message and opens only after confirmation; decline and cancel; axe checks; build-output URL scan.
**Acceptance Criteria:**
- [ ] Every allowed form field type renders and validates.
- [ ] URL handling meets the spec's client requirements.
- [ ] The view passes the same security and accessibility checks as the approval app.

---

## 25.8 Eval, replay, and hostile-server tests for human input

**Parent:** #25 Elicitation and human input
**Task Description:** Make human input deterministic in evals and replay, and prove the elicitation path holds against malicious servers and injected instructions.
**Expected Inputs:** Eval suites, recorded logs, hostile server fixtures.
**Expected Output:** `HumanScript.inputs` rules in `packages/eval/src/human.ts`, replay serving of recorded `input_resolved` in `packages/replay/src/ports/replay-human.ts`, sample server tools `confirm_action` (form) and `connect_account` (URL and `-32042`) in `test/fixtures/sample-mcp-server`, `test/fixtures/hostile-elicitation-server/`, `test/elicitation.int.test.ts`, red-team and prompt-injection additions.
**Dependencies:** none.
**Items it depends on:** 25.4, 25.5, 16.6, 9.2, 6.7, 22.5.
**Implementation guidance:**
1. Simulated human: `inputs: { match: { source?, serverId?, mode? }, action, answer?: JsonValue }[]` with a `default` action (`decline`); answers are validated with the schema like real ones. Reports count inputs by action.
2. Replay: live elicitations replay as part of the recorded tool result (the replay tool port does not re-trigger them); durable inputs (`agent.ask_user`, `-32042`) are answered from recorded `input_resolved` events through `resolveInput`. Diffs (9.4) include `input_wait` safe events.
3. Hostile server fixture: password and card fields in form mode; nested and oversized schemas; ReDoS patterns; an elicitation flood; elicitation with no active call; `javascript:`, `data:`, credential-bearing, and punycode URLs; a completion notification for an unknown id; a message containing instructions aimed at the human or the model; a message echoing a canary value.
4. Assertions: every hostile request is declined, cancelled, or flagged as specified; counters match; no canary reaches telemetry, logs, or unintended events; the obedient model (22.5) cannot answer an input through any model-visible tool; invariant (g) in 22.6 holds for every trial.
5. Add red-team suite tasks (22.6) for self-answering and for using elicitation messages to steer approvals.
**Tests to write:** the integration suite above in the `integration` stage; eval tasks with scripted inputs in replay mode; replay determinism for durable inputs; red-team additions in the `gates` stage.
**Acceptance Criteria:**
- [ ] Evals and replays handle human input deterministically.
- [ ] Every hostile elicitation behavior is contained and counted.
- [ ] No model-visible path can answer a human input.
