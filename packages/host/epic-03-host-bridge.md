# Epic #3: Host bridge (validating app telemetry)

**Goal:** the harness side of MCP Apps: render untrusted app UIs in a locked-down sandbox, hand them trace context, and accept their telemetry only through a validating, rate-limited, host-stamped door. Read `docs/engineering/CONVENTIONS.md` first, plus epic 4.
**Tasks:** 3.1 to 3.8, all size S.

Shared design for this epic:
- The harness is the **MCP Apps host**. Apps are third-party, untrusted code. The host is the only component that talks to the collector pipeline.
- Package `packages/host` has two parts: `src/server/` (Node, owns MCP clients, validation, telemetry, policy) and `src/web/` (browser reference UI bundled with esbuild). Browser code never receives secrets or raw detokenized values unless a human explicitly reveals them (17.5, 5.4).
- MCP Apps is the official extension `io.modelcontextprotocol/ui` (CONVENTIONS section 10: ext-apps specification revision 2026-01-26, package `@modelcontextprotocol/ext-apps`). The host uses the package's `AppBridge` module for iframe rendering, the postMessage JSON-RPC dialect (`ui/initialize` and the other `ui/*` methods), and tool-call proxying. Where this document names a method it is descriptive; use the real name from the pinned package and record it in the PR.
- The host advertises the extension per request in `_meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] }` (MCP 2026-07-28) and only for servers whose config enables apps. Servers that do not support the extension fall back to text content.
- Defaults are deny: no network from the iframe, no tool calls from the app except an explicit per-app allowlist, no top navigation.

---

## 3.1 Reference host page: sandboxed iframe with no network

**Parent:** #3 Host bridge
**Task Description:** Build a minimal web host that renders a `ui://` resource in a sandboxed iframe and connects it with the SDK's host-side bridge.
**Expected Inputs:** An MCP server exposing a `ui://` resource and a tool whose metadata references it.
**Expected Output:** `packages/host/src/server/index.ts` (static server + WebSocket/SSE to the browser), `packages/host/src/web/{index.html,host.ts,bridge.ts}`, host config fragment `packages/schemas/src/config/host.ts` (`apps: { id: Code, resourceUri: string, telemetry: boolean, allowedTools: Code[] }[]`), docs `docs/host.md`.
**Dependencies:** `@modelcontextprotocol/ext-apps` (`AppBridge` host module), `@modelcontextprotocol/client` (v2), `esbuild`, Playwright (test only).
**Items it depends on:** 6.2, 1.8.
**Implementation guidance:**
1. Server: serves the static page on `127.0.0.1` only by default (`host.listen` config), exposes a local-only channel (WebSocket) to the browser carrying host events. Require a random per-process bearer token (printed once via CLI output, never logged) for the channel; reject cross-origin requests (`Origin` check).
2. Resource fetch: tools declare their UI with `_meta.ui.resourceUri`; the host may preload it. The server reads it via MCP `resources/read` from the originating server and validates the MIME type is `text/html;profile=mcp-app` and size at most 1 MiB. Resource `_meta.ui.permissions` (camera, microphone, and so on) are denied unless listed in `host.permissionAllowlist` (default empty); `_meta.ui.csp` domains are honored only when allowlisted (step 3).
3. Iframe: create with `sandbox="allow-scripts"` only (no `allow-same-origin`, no `allow-top-navigation`, no `allow-forms`, no `allow-popups`), `referrerpolicy="no-referrer"`, content via `srcdoc` wrapped with a CSP meta tag: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`. Ignore any CSP domains the resource requests unless the domain appears in `host.cspAllowlist` (default empty); log a code `app_csp_request_ignored`.
4. Connect with the SDK host bridge, implementing only: initialization, delivering the tool input and result to the app, and receiving the app's calls (routed to 3.3's handler).
5. Each app instance gets a `sessionId` (ULID) and an `appId` from config; an iframe for an unknown `resourceUri` is refused (`app_unknown`).
**Tests to write:** Playwright test with a trivial test app: iframe attributes exactly as specified (no `allow-same-origin`); the app attempts `fetch("https://example.test")`, `XMLHttpRequest`, `WebSocket`, `new Image().src` and reports each as blocked (CSP); unknown resource refused; server rejects requests without the token or with a foreign `Origin`.
**Acceptance Criteria:**
- [ ] No network access is possible from the app iframe in the test.
- [ ] Host listens on loopback only and requires a token.
- [ ] Unknown app resources are refused.

---

## 3.2 Deliver `traceparent` to the app

**Parent:** #3 Host bridge
**Task Description:** Create a UI session span and pass its context to registered apps in the tool-result notification metadata.
**Expected Inputs:** Tool result for a UI-linked tool call, app config with `telemetry: true`.
**Expected Output:** `packages/host/src/server/ui-session.ts` (`UiSession`), span definition `harness.ui_session`, injection of `_meta.traceparent` into the result notification to the app.
**Dependencies:** `@opentelemetry/api`.
**Items it depends on:** 3.1, 4.1.
**Implementation guidance:**
1. `UiSession` starts `harness.ui_session` as a child of the originating `harness.tool_call` span (attributes `harness.run.id`, `harness.app.id` (code), `harness.ui.session_id` (id)) and ends it when the iframe is removed or the run resumes.
2. When delivering the tool result to the app (the bridge's tool-result notification, verify name), add `_meta: { traceparent: "00-<traceId>-<sessionSpanId>-01" }` only if `apps[].telemetry` is true; never include `tracestate` or `baggage`.
3. Document that the trace id is a correlation identifier visible to app code and therefore only apps with `telemetry: true` receive it.
4. If the span context is invalid, deliver the result without `_meta` and log `ui_trace_unavailable`.
**Tests to write:** app receives well-formed `traceparent` equal to the session span; app with `telemetry: false` receives none; no baggage or tracestate; session span ends on iframe removal (spy exporter).
**Acceptance Criteria:**
- [ ] Only opted-in apps receive trace context.
- [ ] The session span is a child of the tool-call span and always ends.
- [ ] No other propagation fields are sent.

---

## 3.3 Host-local telemetry tool and app tool-call policy

**Parent:** #3 Host bridge
**Task Description:** Receive app telemetry through a host-local, app-only tool and restrict which other tools an app may call.
**Expected Inputs:** App-initiated tool calls over the bridge.
**Expected Output:** `packages/host/src/server/app-calls.ts` (`AppCallRouter`), host-local tool `harness.telemetry.emit` declared app-only through the MCP Apps tool visibility metadata.
**Dependencies:** none.
**Items it depends on:** 3.1, 3.2.
**Implementation guidance:**
1. `AppCallRouter.handle(session, request)`: if the tool name is `harness.telemetry.emit`, handle locally (never forward to any MCP server). If the name is in `apps[session.appId].allowedTools`, forward through the normal tool pipeline (policy 17.3 still applies, with `context.subagent=false` and an added policy context key `app: <appId>`). Anything else returns a JSON-RPC error `app_tool_not_allowed` and counts `harness.host.app_rejected{reason="unknown_tool"}`.
2. The telemetry tool is declared with visibility restricted to the app (the ext-apps 2026-01-26 visibility field, `_meta.ui.visibility: ["app"]`; verify against the pinned package) and is **never** part of the `ToolSpec` list given to the model; add a test asserting the model-facing registry never contains it.
3. Calls from an app execute with the app session's `runId`; the router rejects calls whose `callId` or approval ids belong to a different run.
4. Apps cannot list or discover other tools; return an empty list for discovery requests unless `allowedTools` is non-empty.
**Tests to write:** local handling (no forwarding, spy on MCP pool); allowed tool forwarded and subject to policy; disallowed tool rejected and counted; model-facing registry excludes the telemetry tool; cross-run id rejected.
**Acceptance Criteria:**
- [ ] Telemetry batches never reach external servers.
- [ ] Apps can call only allowlisted tools, under policy.
- [ ] The model cannot see or call the telemetry tool.

---

## 3.4 Validate telemetry batches against a closed span schema

**Parent:** #3 Host bridge
**Task Description:** Parse and sanitize app span batches, rejecting oversized batches and dropping invalid spans.
**Expected Inputs:** `harness.telemetry.emit` payloads.
**Expected Output:** `packages/host/src/server/app-telemetry.ts` (`AppSpanBatch`, `ingestBatch`), span definitions `harness.ui.render`, `harness.ui.decision`, `harness.ui.error`, `harness.ui.interaction`.
**Dependencies:** none.
**Items it depends on:** 3.3, 4.1.
**Implementation guidance:**
1. `AppSpan` discriminated union on `name`: `ui.render {}`; `ui.decision { decision: "approve"|"deny"|"edit" }`; `ui.error { code: Code }`; `ui.interaction { kind: "click"|"focus"|"edit", count: int(0..1000) }`. Each member also has `startOffsetMs: int(>=0)` and `durationMs: int(0..3_600_000)`, all `.strict()`.
2. `AppSpanBatch = { spans: AppSpan[] (max 50) }` `.strict()`. Reject the **whole batch** if the serialized request exceeds 16 KiB, the array exceeds 50, or the top level is not an object (`reason: "size" | "schema"`). Within a valid-size batch, parse each span independently: invalid spans are dropped and counted (`reason: "schema"`), valid ones accepted.
3. For each accepted span, create the host-side span with the registered definition (`harness.ui.*`), attributes from the validated fields only.
4. Never store or log the raw payload. Return to the app a minimal acknowledgment `{ accepted, dropped }` (integers only).
5. Unknown span names are dropped with `reason: "unknown_span"`.
**Tests to write:** valid batch accepted; each rejection reason; mixed valid/invalid spans; size boundaries (16 KiB exactly allowed, one byte more rejected); strings in numeric fields rejected; unknown extra keys rejected; ack contains only integers; canary strings in invalid fields never appear in exports or logs.
**Acceptance Criteria:**
- [ ] Only schema-valid spans become host spans.
- [ ] Oversized or malformed batches rejected without parsing deeply.
- [ ] No raw app payload is stored or logged.

---

## 3.5 Per-app rate limits and rejection counters

**Parent:** #3 Host bridge
**Task Description:** Protect the pipeline from floods and expose bounded counters for rejections.
**Expected Inputs:** App session ids, ingestion events.
**Expected Output:** `packages/host/src/server/app-limits.ts` (`AppRateLimiter`), counter `harness.host.app_rejected{reason}` and `harness.host.app_spans_accepted`, `METRIC_ALLOWLIST` entries (10.2).
**Dependencies:** none.
**Items it depends on:** 3.4, 10.2.
**Implementation guidance:**
1. Token bucket per `sessionId`: 10 batches per second sustained, burst 20; additional cap of 200 accepted spans per minute and 2,000 per session lifetime (configurable under `host.limits`). Use the injected clock.
2. Exceeding a limit rejects the request with JSON-RPC error `rate_limited` (batch limit) or silently drops with counting (lifetime cap) so a misbehaving app cannot keep forcing error paths.
3. Counter `harness.host.app_rejected` has one attribute `reason` (enum `schema | size | rate | unknown_app | unknown_tool | unknown_span | session_cap`); `harness.host.app_spans_accepted` has no attributes. Add both to `METRIC_ALLOWLIST` and regenerate the collector allowlist.
4. Limiter state is dropped when the session ends.
5. Never label metrics with app id or session id (cardinality and correlation).
**Tests to write:** bucket refill with fake clock; burst boundary; per-minute and lifetime caps; counters with correct reasons; limiter memory freed on session end; metric attribute set restricted to the enum.
**Acceptance Criteria:**
- [ ] A flooding app cannot exceed configured limits.
- [ ] Rejections are counted with bounded reasons.
- [ ] No per-app labels on metrics.

---

## 3.6 Host-stamped attributes and trusted timing

**Parent:** #3 Host bridge
**Task Description:** Ensure identity and timing on app-originated spans come from the host, never from the app.
**Expected Inputs:** Validated app spans, session context.
**Expected Output:** `packages/host/src/server/stamp.ts` (`stampAppSpan`), tests proving spoofing is impossible.
**Dependencies:** none.
**Items it depends on:** 3.4.
**Implementation guidance:**
1. Host-stamped attributes: `harness.app.id` (from the iframe binding), `harness.run.id` (session's run), `harness.ui.session_id` (host ULID). The `AppSpan` schema contains none of these keys, and `.strict()` rejects them if an app sends them (counted as `schema`).
2. Timing: `endTime = hostReceiveTime`; `startTime = max(sessionStart, endTime - durationMs)`; ignore any other time information. Clamp `durationMs` to `[0, endTime - sessionStart]`.
3. Parent: the `harness.ui_session` span from 3.2 (explicitly set via `parent` option of the registry `start`).
4. A span claiming to be `ui.decision` is accepted only if the session has a pending approval for this run (else reason `unknown_span`) to prevent decorative spoofing.
5. The stamped span is created through the registry so the standard allowlist and sentinel still apply downstream.
**Tests to write:** attempt to send `harness.run.id` in a span (rejected); timing computed from host clock with fake clock, ignoring huge `durationMs`; parent linkage; `ui.decision` rejected when no pending approval; end-to-end through allowlist processors.
**Acceptance Criteria:**
- [ ] App cannot set identity or timestamps on exported spans.
- [ ] Parent linkage is host-controlled.
- [ ] Decision spans require a pending approval.

---

## 3.7 Hostile app fixtures and headless integration test

**Parent:** #3 Host bridge
**Task Description:** Prove the whole door holds against a deliberately malicious app.
**Expected Inputs:** Hostile app HTML fixtures served as `ui://` resources.
**Expected Output:** `test/fixtures/hostile-app/*.html`, `test/host-hostile.int.test.ts`, Playwright setup in the pipeline (`npx playwright install --with-deps chromium`).
**Dependencies:** Playwright.
**Items it depends on:** 3.5, 3.6, 8.5.
**Implementation guidance:**
1. Fixtures (each a separate app) attempting: oversized batch (100 KiB); spoofed attributes; fields stuffed with canary strings (10 KiB); unknown span names; flood (1,000 batches in one second); calling forbidden tools (`filesystem.write`, another app's tool); network exfiltration via `fetch`, XHR, WebSocket, image beacon, `navigator.sendBeacon`; `window.top.location` navigation and `window.open`; malformed JSON-RPC over `postMessage`; reading the parent DOM; replaying an old session id.
2. The test hosts each fixture in the reference host with an in-memory span exporter and metric reader and asserts: only schema-valid spans exported; counters match expected reasons; no canary appears in exported spans, logs, metrics, or captured stdout (reuse the canary harness from 8.5); network attempts fail; top navigation and popups blocked; forbidden tool calls rejected; the host process stays responsive during the flood (a legitimate batch is accepted afterward).
3. Report violations as `ui.error` codes from inside the app (for example `csp_blocked`) and assert they arrive as valid spans.
4. Run in the Azure `integration` stage with Chromium installed; upload Playwright traces on failure as artifacts.
**Tests to write:** the integration suite above, one test per fixture.
**Acceptance Criteria:**
- [ ] Every hostile behavior is contained and counted.
- [ ] No canary data leaves through telemetry.
- [ ] Legitimate traffic still works after the flood.

---

## 3.8 Host context, display modes, and gated app-to-host requests

**Parent:** #3 Host bridge
**Task Description:** Give apps a good, consistent UX (theme, display mode, sizing) through the MCP Apps host context, and gate the app requests that can reach the model or the outside world.
**Expected Inputs:** App `ui/*` requests over the bridge, host settings.
**Expected Output:** host context provider in `packages/host/src/server/host-context.ts`, display-mode handling in `packages/host/src/web/`, request gates in `packages/host/src/server/app-requests.ts`, config `host.apps[].allow: { openLink, message, modelContext }`, docs `docs/host.md` sections "UX" and "App requests".
**Dependencies:** `@modelcontextprotocol/ext-apps` (verify the host-context fields, display modes, and the `ui/*` request names in the pinned revision).
**Items it depends on:** 3.3, 3.6, 13.4, 17.3.
**Implementation guidance:**
1. Host context: send theme (light or dark, plus the documented CSS variables), locale, time zone, available display modes (inline, fullscreen, picture-in-picture where supported), and container size limits during `ui/initialize`; push updates when they change. Apps resize within host limits; size requests above the limits are clamped.
2. Open-link requests: off by default per app. When allowed, show the full URL with the registrable domain highlighted and a punycode warning, and open it only after explicit user consent, in the user's browser (never inside the harness). The same component serves URL-mode elicitation (25.4).
3. Message and model-context requests (apps asking to add a message or context for the model): off by default per app. When allowed, the content is untrusted: it passes the PII tokenizer (boundary `model_input`), is recorded as content with the app id, and is clearly labeled as app-provided in the transcript; it can never resolve approvals or inputs.
4. App tool calls stay under 3.3 (allowlist plus policy). Every gated request is counted with a bounded reason code; payloads are never logged.
**Tests to write:** host context delivery and updates (Playwright with a test app); size clamping; open-link denied by default, allowed with consent, URL display rules; message requests denied by default, tokenized and labeled when allowed; counters bounded; hostile app attempts (from 3.7) still contained.
**Acceptance Criteria:**
- [ ] Apps render with the host's theme and display modes.
- [ ] Apps cannot open links or reach the model without per-app opt-in and user consent.
- [ ] App-provided content is tokenized and labeled as untrusted.

