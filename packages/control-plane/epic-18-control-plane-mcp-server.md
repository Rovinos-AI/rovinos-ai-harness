# Epic #18: Control-plane MCP server

**Goal:** expose run control (list, inspect, approve, deny, resume, cancel) as an MCP server so any MCP client, and any MCP Apps-capable client in particular, becomes a human-in-the-loop console for the harness. Read `docs/engineering/CONVENTIONS.md` first, plus epics 5 (approval app), 17 (approvals), and 2 (resume and cancel).
**Tasks:** 18.1 to 18.7, all size S.

Shared design for this epic:
- Package `packages/control-plane` uses the official MCP TypeScript SDK server API (`McpServer`, streamable HTTP and stdio transports; verify names). Started with `harness serve [--stdio | --http]`.
- **Metadata by default.** Tool outputs contain statuses, ids, counts, and timings, never message content. Content-bearing outputs exist only in approvals (tokenized args) and in an explicit, audited reveal (18.4).
- **An agent must never approve its own actions.** Approve/deny/reveal tools are declared app-only (hidden from models by compliant hosts), and when invoked outside an app they require an out-of-band human confirmation via elicitation (18.2, 18.6). If neither is available the call fails closed.
- Safe defaults: bind to loopback, require bearer tokens with scopes (18.5), audit every call with metadata only.

---

## 18.1 Server scaffold with `list_runs` and `get_run`

**Parent:** #18 Control-plane MCP server
**Task Description:** Create the control-plane server with read-only run inspection tools and a `harness serve` command.
**Expected Inputs:** Event store, config.
**Expected Output:** `packages/control-plane/src/{server.ts,tools/list-runs.ts,tools/get-run.ts,schemas.ts}`, `packages/cli/src/commands/serve.ts`, package scaffold.
**Dependencies:** `@modelcontextprotocol/sdk` (server, verify), `zod`.
**Items it depends on:** 2.10, 7.3, 20.2.
**Implementation guidance:**
1. `list_runs` input `{ status?: RunStatus, limit?: int (1..50, default 20), cursor?: string }` -> structured output `{ runs: { runId, status, createdAt, lastTs, lastSeq, steps, pendingApprovals }[], nextCursor? }`. Use `store.listRuns` and a light fold for counts.
2. `get_run` input `{ runId: Id }` -> `{ runId, status, steps, usage, lastCheckpoint?, pendingApprovals: { approvalId, toolId, ruleId, expiresAt? }[], recentEvents: SafeEvent[] (last 20) }`. Recent events use `toSafeEvent` so no content can appear.
3. Define input and output schemas with Zod and register them with the SDK (`outputSchema` + `structuredContent`), plus a short text rendering (counts only) for clients that ignore structured content.
4. Annotations: `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`.
5. `harness serve --stdio` for local clients; `--http [--port N]` starts streamable HTTP on loopback; both build the same server. Startup prints only the endpoint (and token location hint from 18.5), never the token.
6. Unknown run ids return an MCP tool error with code `run_not_found` (code only).
**Tests to write:** in-memory client/server pair: both tools with data and pagination; unknown run; outputs validate against schemas; property test with canaries planted in event content asserting no content in any output; CLI starts and stops cleanly.
**Acceptance Criteria:**
- [ ] Tools return metadata only (verified by canary test).
- [ ] Structured and text outputs both provided.
- [ ] `harness serve` works over stdio and loopback HTTP.

---

## 18.2 Decision and lifecycle tools with a confirmation gate

**Parent:** #18 Control-plane MCP server
**Task Description:** Add `approve`, `deny`, `resume_run`, `cancel_run`, and a supervisor that executes resumes, protecting against self-approval.
**Expected Inputs:** Tool calls from MCP clients or apps.
**Expected Output:** `packages/control-plane/src/tools/{approve,deny,resume-run,cancel-run}.ts`, `packages/control-plane/src/confirmation-gate.ts`, `packages/control-plane/src/run-supervisor.ts`.
**Dependencies:** none.
**Items it depends on:** 18.1, 17.4, 2.7, 2.13.
**Implementation guidance:**
1. `approve { approvalId, edits? }` and `deny { approvalId, reason?: Code }` use `validateEdits` (17.4) and `resolveApproval` (2.9). They do not resume the run; `resume_run { runId }` does.
2. `RunSupervisor`: runs `resumeRun` in-process asynchronously, returns `{ started: true }` immediately, tracks active runs (`Map<Id, AbortController>`), refuses beyond `controlPlane.maxConcurrentRuns` (default 2, `capacity_exceeded`), maps `resume_conflict` to `{ started: false, code }`. Active runs register with `ActiveRuns` for the sentinel (8.3).
3. `cancel_run { runId }` calls `cancelRun` (2.13); for runs supervised locally also abort the controller.
4. **Confirmation gate** `requireHuman(ctx, summary)`: if the call arrived through an app-visibility tool session marked as an app call (by the host-provided request metadata, verify what the SDK exposes) it passes; otherwise it must obtain an elicitation confirmation (`elicitInput` with a boolean `confirm` field and the tokenized summary). If the client does not support elicitation, fail with `human_confirmation_unavailable`. Applies to `approve`, `deny`, `cancel_run`, and `resume_run`.
5. Declare `approve`/`deny` as app-visibility tools (hidden from models) in addition to being callable through elicitation confirmation; document the trust assumption on the host.
6. Annotations: `destructiveHint` for `cancel_run`, `idempotentHint` true for `deny`/`cancel_run`.
**Tests to write:** approve/deny flows via in-memory client with a fake elicitation responder (accept, decline, cancel); no elicitation support fails closed; supervisor concurrency limit and duplicate resume; cancel stops a supervised run (fake slow tool); edits validated before resolve.
**Acceptance Criteria:**
- [ ] No decision tool succeeds without an app context or a human elicitation confirmation.
- [ ] Concurrency limits enforced for supervised runs.
- [ ] Decisions are recorded in the log exactly once.

---

## 18.3 Run-list console as a `ui://` MCP App

**Parent:** #18 Control-plane MCP server
**Task Description:** Provide a visual run console for MCP Apps-capable clients.
**Expected Inputs:** `list_runs`/`get_run` tools (app-visible copies).
**Expected Output:** `packages/control-plane/app/runs-console/` (TS + CSS), build to `dist/runs-console.html`, resource `ui://harness/runs/v1`, tool metadata linking `list_runs` to the resource.
**Dependencies:** `esbuild`, `@modelcontextprotocol/ext-apps` (client side, verify), `jsdom`.
**Items it depends on:** 18.1, 5.3.
**Implementation guidance:**
1. Same security posture as 5.3: DOM built with `textContent`, no network, single-file build, build fails on external URLs.
2. Features: table of runs (status badge, id, age, steps, pending approvals), status filter, refresh every 5 s using the bridge `callTool` for `list_runs` (app-visible copy exposed alongside the model-visible one), detail panel via `get_run`, "needs approval" badge opening the approval view (18.4) in the same iframe.
3. Metadata only: never request content. Poll pauses when the document is hidden and backs off on errors.
4. Accessibility parity with 5.3 (landmarks, table semantics, live region for updates).
5. Emit the standard UI spans via the shim (`ui.render`, `ui.error`, `ui.interaction`).
**Tests to write:** jsdom rendering with stub bridge (empty list, long list, filter, pending badge); polling pause/resume with fake timers; axe checks; build-output external URL scan; XSS in run ids/status strings (even though they are ids, test defensively).
**Acceptance Criteria:**
- [ ] Console renders and updates with metadata only.
- [ ] Needs-approval runs link to the approval view.
- [ ] Meets the same security and accessibility checks as the approval app.

---

## 18.4 Approval view hosting and the app-only `resolve` and `reveal` tools

**Parent:** #18 Control-plane MCP server
**Task Description:** Serve the approval app resource and implement the server side of its two app-only tools with strict controls.
**Expected Inputs:** `harness.approvals.resolve` and `harness.approvals.reveal` requests (schemas from 5.4).
**Expected Output:** `packages/control-plane/src/resources/approval.ts` (serves `ui://harness/approval/v1` from the approval app build), `packages/control-plane/src/tools/approvals-app.ts`.
**Dependencies:** none.
**Items it depends on:** 18.2, 5.4, 12.7.
**Implementation guidance:**
1. Resource: read `packages/approval-app/dist/approval.html` at startup (fail if missing), serve with the MCP Apps HTML MIME type (verify), declaring no CSP domains and no extra permissions.
2. `harness.approvals.resolve`: validate against `ResolveRequest`; verify the approval exists, is pending, and belongs to a run the token may act on (18.5 scope `approve` and run filter); apply `validateEdits`; call `resolveApproval`; return `{ ok: true }` or `{ ok: false, code }`.
3. `harness.approvals.reveal`: requires scope `reveal` and config `controlPlane.allowReveal: true` (default false); at most 20 pointers; rate limit 5 per minute per session; if the client supports elicitation and `controlPlane.reveal.requireElicitation` is true (default true), obtain a confirmation first; resolve tokens at the requested pointers through `AuditingVaultResolver` with boundary `ui` (12.7); return values only for pointers present in the stored payload args (never arbitrary pointers into other data).
4. Both tools are app-visibility only and are omitted from `tools/list` for clients that do not advertise MCP Apps support (18.7).
5. Metadata-only audit logging (token id, tool, outcome code).
**Tests to write:** resolve success, not found, already resolved, wrong-run token, invalid edits; reveal disabled by default; reveal scope, rate limit, pointer validation, elicitation requirement; audit events emitted with counts only (canary); resource served and MIME type correct; missing build artifact fails startup.
**Acceptance Criteria:**
- [ ] Reveal is off by default and audited when on.
- [ ] Tools are unreachable without the right scope and run access.
- [ ] Approval app resource served from the real build.

---

## 18.5 Authentication, scoping, and network binding

**Parent:** #18 Control-plane MCP server
**Task Description:** Secure the control plane: bearer tokens with scopes, loopback by default, DNS-rebinding protection, rate limits, and audit logging.
**Expected Inputs:** Config `controlPlane`, incoming requests.
**Expected Output:** `packages/control-plane/src/auth.ts`, config fragment `packages/schemas/src/config/control-plane.ts`, docs `docs/control-plane-security.md`.
**Dependencies:** Node `crypto` (`timingSafeEqual`).
**Items it depends on:** 18.1, 20.3.
**Implementation guidance:**
1. Config: `auth.tokens: { id: Code, secret: SecretRef, scopes: ("read"|"approve"|"run"|"reveal"|"admin")[], runIds?: Id[] }[]`, `listen: { host: string (default "127.0.0.1"), port }`, `tls?: { certFile: SecretRef-like path, keyFile }`, `allowedHosts: string[]` (Host header allowlist, default loopback names), `rateLimitPerMinute` (default 120).
2. Authenticate `Authorization: Bearer <token>`; compare using SHA-256 digests with `timingSafeEqual`; unknown token returns 401 without detail. Tokens are resolved via `SecretResolver` at startup and never logged.
3. Scopes enforced per tool: `read` (list/get), `approve` (approve/deny/resolve), `run` (resume/cancel), `reveal` (reveal), `admin` (all). `runIds` restricts accessible runs.
4. Startup rules: refuse to bind a non-loopback host without `tls`; refuse to start with zero tokens in HTTP mode (stdio mode is trusted local only); reject requests whose `Host` header is not in `allowedHosts` and, when present, whose `Origin` is not same-host (DNS rebinding and CSRF defense).
5. Per-token rate limit (token bucket with injected clock); exceeding returns 429.
6. Audit log through the sanctioned logger: `{ tokenId (Code), tool (Code), outcome (Code) }` only.
**Tests to write:** valid and invalid tokens (including timing-safe path via function-level test), each scope boundary, run filtering, non-loopback without TLS refused, Host/Origin checks table, rate limiting, audit entries contain no secrets (canary), stdio mode unauthenticated but local.
**Acceptance Criteria:**
- [ ] Remote exposure without TLS is impossible by configuration.
- [ ] Every tool enforces its scope and run filter.
- [ ] Tokens and values never appear in logs.

---

## 18.6 Elicitation fallback path for clients without MCP Apps

**Parent:** #18 Control-plane MCP server
**Task Description:** Let text-only clients resolve approvals through MCP elicitation.
**Expected Inputs:** Approval ids, client capabilities.
**Expected Output:** `packages/control-plane/src/tools/review-approval.ts`, helper `elicitDecision`.
**Dependencies:** none.
**Items it depends on:** 18.2, 17.4.
**Implementation guidance:**
1. `review_approval { approvalId }` (model-visible, safe because a human decides): load the payload and, if the client supports elicitation (verify capability negotiation fields), call `elicitInput` with message = payload `fallbackText` (tokenized) and a requested schema `{ decision: enum["approve","deny"], reason?: Code enum }`.
2. Outcomes: accept with `approve` -> `approve` logic (18.2, no second confirmation needed since the elicitation is the confirmation); `deny` likewise; user declines or cancels -> no state change, return `{ resolved: false }`.
3. Clients without elicitation: return a text result with the CLI instructions (`harness approvals approve <id>`) and the console URL if configured, and `resolved: false`.
4. Edits are not supported in this path (the schema allows only approve/deny); payloads requiring edits mention the CLI or app.
5. The elicitation message contains only tokenized content; never raw values.
**Tests to write:** fake client with elicitation (accept/approve, accept/deny, decline, cancel); client without elicitation returns instructions; message contains no canary raw values; edits not offered.
**Acceptance Criteria:**
- [ ] A text-only client can approve or deny via elicitation.
- [ ] No state changes unless the human explicitly accepts.
- [ ] Fallback text points to CLI or app.

---

## 18.7 Compatibility tests and capability-based tool exposure

**Parent:** #18 Control-plane MCP server
**Task Description:** Verify behavior across client types and make tool listing depend on negotiated capabilities.
**Expected Inputs:** SDK test clients with different capabilities; the reference host (3.1) as an MCP Apps-capable client.
**Expected Output:** `packages/control-plane/src/capabilities.ts` (tool filtering), `test/control-plane-compat.int.test.ts`, docs `docs/control-plane-clients.md` with a compatibility matrix.
**Dependencies:** Playwright, SDK client.
**Items it depends on:** 18.3, 18.4, 18.5, 18.6.
**Implementation guidance:**
1. `tools/list` filtering: if the client does not advertise MCP Apps/UI support, omit app-only tools (`harness.approvals.*`) and app-visibility copies of list/get tools.
2. Matrix of clients: (A) SDK client with no UI and no elicitation; (B) SDK client with elicitation only; (C) reference host as an MCP Apps-capable client. For each, assert: tools listed; read tools work; approval path available (CLI instructions, elicitation, or app); self-approval attempts via the model-visible path fail closed (A) or require human elicitation (B).
3. Scenario test per client: create a run that suspends for approval (fake model and a policy `ask` rule), resolve using the client's available path, resume, assert completion.
4. Document the matrix and note unknown behaviors of third-party clients as "unverified".
5. Run in the Azure `integration` stage (Chromium for client C).
**Tests to write:** the matrix tests above, including tool-list assertions per capability set.
**Acceptance Criteria:**
- [ ] Each client class has a working approval path or a clear fail-closed message.
- [ ] App-only tools are never listed to clients without UI support.
- [ ] Compatibility matrix documented.
