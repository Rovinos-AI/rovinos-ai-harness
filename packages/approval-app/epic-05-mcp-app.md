# Epic #5: MCP App (approval app and telemetry shim)

**Goal:** a reference human-in-the-loop approval UI delivered as an MCP App, plus a tiny telemetry shim any app can use to report metadata-only spans through the host. Read `docs/engineering/CONVENTIONS.md` first, then epic 3 (the host) and epic 17 (approval payloads).
**Tasks:** 5.1 to 5.7, all size S.

Shared design for this epic:

- The app runs in a locked-down iframe (3.1): no network, scripts only, no same-origin. All I/O happens through the host bridge.
- **Never trust payload strings.** Render with `textContent`/DOM APIs; never use `innerHTML` with payload data. Add a test with an XSS payload.
- **The app never sees raw sensitive values by default.** It renders tokenized args. Raw values appear only after an explicit, audited human "reveal" (5.4), are held in memory, and are auto-hidden.
- Views use the `App` class from `@modelcontextprotocol/ext-apps` (extension `io.modelcontextprotocol/ui`, specification revision 2026-01-26 per CONVENTIONS section 10). Resources are served as `ui://harness/<view>/v1` with MIME type `text/html;profile=mcp-app`, no `_meta.ui.csp` domains, and no `_meta.ui.permissions`.
- This package holds **every harness MCP App view** (approval, human input, run console, run inspector, reports) and the shared UI kit (5.7). Each view builds to its own single-file HTML; the control plane serves them.
- Packages: `packages/app-telemetry` (browser-safe, no Node APIs, no dependencies), `packages/approval-app` (builds to a single HTML file served as `ui://harness/approval/v1`). Shared browser-safe schemas live in `@rovinos/schemas` (`app-span.ts`, `approval-tools.ts`).

---

## 5.1 `@rovinos/app-telemetry` shim: typed `start`/`end` for manifest-declared spans

**Parent:** #5 MCP App
**Task Description:** Create the tiny browser library that apps use to record the closed set of UI spans.
**Expected Inputs:** A bridge-like object with a `callTool` method; a manifest of allowed span names.
**Expected Output:** `packages/app-telemetry/src/{index.ts,types.ts}`, `packages/schemas/src/app-span.ts` (the `AppSpan` schema moved from 3.4 and re-exported to the host), esbuild config producing ESM and IIFE bundles, bundle-size test.
**Dependencies:** `esbuild`, `zod` (types and schema only in `schemas`; the shim itself must not import Zod at runtime: use plain TypeScript types and hand-written validation).
**Items it depends on:** 3.4, 1.1.
**Implementation guidance:**

1. Move the `AppSpan` Zod schema from the host into `@rovinos/schemas/src/app-span.ts` (browser-safe) and update 3.4 to import it. The shim uses the inferred **types** only.
2. API:

```ts
interface AppTelemetry {
  readonly active: boolean;
  start(name: "ui.render" | "ui.decision" | "ui.error" | "ui.interaction"): { end(attrs?: SpanAttrs<typeof name>): void };
  record(name, attrs, durationMs?): void;      // for already-measured durations
  flush(): Promise<void>;
}
createAppTelemetry({ bridge, manifest: { spans: [...] }, now?: () => number }): AppTelemetry
```

`SpanAttrs<N>` is a mapped type tied to the schema (`ui.decision` requires `decision`, `ui.error` requires `code`, and so on). Calling `start` with a name not in the manifest is a TypeScript error and a runtime no-op.
3. Durations use `performance.now()` differences (`now` injectable); offsets are relative to shim creation.
4. The shim never calls `fetch`, `XMLHttpRequest`, `WebSocket`, or `navigator.sendBeacon` (add a lint test searching the bundle for those identifiers).
5. Size budget: the minified+gzipped IIFE bundle must be under 4 KB; enforce in a test that builds with esbuild and measures gzip size.
**Tests to write:** type-level tests (`expectTypeOf`) for per-name attribute requirements; runtime no-op for undeclared names; duration math with fake `now`; bundle-size test; forbidden-identifier scan.
**Acceptance Criteria:**

- [ ] Apps can only record spans declared in their manifest, with typed attributes.
- [ ] Bundle under 4 KB gzip with no network APIs.
- [ ] Host and shim share one schema source.

---

## 5.2 Shim transport: batching, backoff, no-op without a host

**Parent:** #5 MCP App
**Task Description:** Send recorded spans to the host efficiently and safely, degrading to a silent no-op when telemetry is unavailable.
**Expected Inputs:** Recorded spans, host bridge `callTool`.
**Expected Output:** `packages/app-telemetry/src/transport.ts`, activation logic, informational trace context accessor.
**Dependencies:** none.
**Items it depends on:** 5.1, 3.3.
**Implementation guidance:**

1. Activation: `active` becomes true only after the host confirms the host-local tool `harness.telemetry.emit` is callable (call it once with an empty batch `{ spans: [] }` during init, with a 2 s timeout). On failure or timeout the shim stays inactive and every method returns immediately.
2. Batching: flush when 20 spans are pending, every 2 s (timer), and on `pagehide`/`visibilitychange` hidden. Never exceed 50 spans or 14 KiB per call (the host limit is 16 KiB; leave headroom by measuring `JSON.stringify` length).
3. Backpressure: on a `rate_limited` error back off exponentially (500 ms doubling to 8 s) and keep at most 100 pending spans, dropping the oldest. Keep an integer `dropped` count (exposed via `stats()`, not sent).
4. Never throw into app code: all transport errors are swallowed; the shim exposes only `stats()` for debugging.
5. `traceContext`: parse the `traceparent` delivered in the tool-result notification `_meta` (host-provided, 3.2) and expose `traceId` read-only for display or support references. It is **not** attached to spans (the host stamps parentage).
6. Provide `dispose()` clearing timers and flushing once.
**Tests to write:** activation success and failure paths; batch size and byte limits; timer and visibility flushes with fake timers; backoff schedule; drop-oldest behavior; no thrown errors under bridge failure; trace id parsing (valid, invalid, absent).
**Acceptance Criteria:**

- [ ] A host without telemetry support leaves the app fully functional.
- [ ] Batches never exceed host limits.
- [ ] Transport failures never surface to the app.

---

## 5.3 Approval app UI: render the pending action with tokenized values

**Parent:** #5 MCP App
**Task Description:** Build the accessible approval screen that displays an approval payload.
**Expected Inputs:** `ApprovalPayload` (17.4) delivered via the bridge as tool input/result.
**Expected Output:** `packages/approval-app/src/{main.ts,view.ts,styles.css,tokens.ts}`, build script producing `dist/approval.html` (single file, inline script and style, no external requests), content-hash header comment.
**Dependencies:** `esbuild`, `jsdom` (tests), `@modelcontextprotocol/ext-apps` (`App` class).
**Items it depends on:** 5.1, 17.4, 3.1.
**Implementation guidance:**

1. Connect with the SDK app class, receive tool input/result, validate with the shared `ApprovalPayload` schema (import from `@rovinos/schemas`; the payload schema must be browser-safe). Invalid payload renders an error state and reports `ui.error` code `payload_invalid`.
2. Layout: heading (`summary`), meta row (tool id, rule id, reason, expiry countdown), arguments viewer (collapsible tree). In strings, tokens matching the token pattern render as pills showing the entity type (`<EMAIL_1>` -> pill "email 1") with the token as the accessible name; never attempt to resolve them here.
3. Buttons: **Approve**, **Deny**, and **Edit** (only when `editableFields` is non-empty); focus starts on the heading; buttons are real `<button>` elements with visible focus rings; support keyboard shortcuts only through standard focus order.
4. Accessibility: semantic landmarks, ARIA labels, live region for status changes, contrast at least 4.5:1, respects `prefers-color-scheme` and `prefers-reduced-motion`, works at 320 px width.
5. Security: build DOM with `createElement` and `textContent` only; no `innerHTML`, no `eval`, no inline event attributes, no external fonts or images; build script fails if the output contains `http://` or `https://` URLs (other than inside documentation comments stripped at build).
6. Expired payloads (`expiresAt` in the past) disable actions and show an expired state.
**Tests to write:** jsdom rendering tests (all fields shown, token pills, expired state, edit button visibility); XSS payload (`<img src=x onerror=alert(1)>`, `javascript:` strings) renders as text; accessibility checks with `axe-core` in jsdom; build-output scan for external URLs.
**Acceptance Criteria:**

- [ ] Payload strings can never inject markup.
- [ ] Built file has no external references.
- [ ] axe reports no violations on the main states.

---

## 5.4 Authorized reveal and the approve, deny, and edit flows

**Parent:** #5 MCP App
**Task Description:** Implement the decision flows and the audited, time-limited reveal of raw values.
**Expected Inputs:** User gestures, host-local approval tools.
**Expected Output:** `packages/schemas/src/approval-tools.ts` (`ResolveRequest`, `ResolveResponse`, `RevealRequest`, `RevealResponse`), app logic `packages/approval-app/src/actions.ts`, edit form builder `packages/approval-app/src/edit-form.ts`.
**Dependencies:** none.
**Items it depends on:** 5.3, 17.4.
**Implementation guidance:**

1. Tool contracts (Zod, browser-safe): `harness.approvals.resolve { approvalId: Id, decision: "approve"|"deny"|"edit", edits?: { pointer: string, value: JsonValue }[] } -> { ok: boolean, code?: Code }` and `harness.approvals.reveal { approvalId: Id, pointers: string[] (max 20) } -> { values: { pointer: string, value: string }[] }`. The control-plane (18.4) implements them as host-local, app-visibility tools; in this task test with a stub host.
2. Approve/Deny: single click, disable buttons while pending, show result state; on error code show message by code only and report `ui.error` (`resolve_failed`).
3. Edit: build one input per `editableFields` pointer, typed by the current value (string, number, boolean) with a JSON textarea fallback for objects; display current tokenized value; submit sends only changed pointers. Client validation is a convenience; the server validates authoritatively (17.4). A string edit containing a raw sensitive value is tokenized server-side.
4. Reveal: a **Reveal values** button opens a confirmation dialog ("Show raw values for N fields? This is logged."). On confirm call `reveal`; show values in place of pills for **30 seconds**, then re-mask automatically; revealed data lives only in a closure variable (not in the DOM beyond display, not in storage, not in telemetry). A second reveal requires another confirmation.
5. After a successful decision emit `ui.decision` via the shim (5.5) and show the final state; do not auto-close.
**Tests to write:** jsdom tests with stub bridge: approve, deny, edit (only changed pointers sent, types preserved), reveal confirm/cancel, auto re-mask with fake timers, buttons disabled while pending, error code handling, no raw value persisted after re-mask (inspect DOM and closure-exposed test hook).
**Acceptance Criteria:**

- [ ] All three decisions work against the stub host.
- [ ] Reveal requires explicit confirmation and auto-masks after 30 s.
- [ ] Revealed values never reach telemetry or persistent storage.

---

## 5.5 UI spans: render, decision, error, interaction

**Parent:** #5 MCP App
**Task Description:** Instrument the app with the closed set of metadata-only spans.
**Expected Inputs:** App lifecycle events.
**Expected Output:** `packages/approval-app/src/telemetry.ts`, global error and CSP violation handlers.
**Dependencies:** none.
**Items it depends on:** 5.4, 5.2.
**Implementation guidance:**

1. `ui.render`: record the time from payload receipt to first paint (`requestAnimationFrame` twice) exactly once per payload.
2. `ui.decision`: duration from render to the decision click, with `decision` enum; emitted once after a successful resolve.
3. `ui.error`: `code` from the closed set `payload_invalid | bridge_unavailable | resolve_failed | reveal_failed | csp_blocked | render_failed`. `window.onerror` and `unhandledrejection` handlers emit `render_failed` **without** the message. A `securitypolicyviolation` listener emits `csp_blocked`. Deduplicate: at most one `ui.error` per code per session.
4. `ui.interaction`: aggregate counts per `kind` (`click`, `focus`, `edit`) and flush a single span per kind at session end or hide; never one span per event.
5. No free text in any attribute, no field names, no payload data.
**Tests to write:** each span emitted once with correct attributes (capture via fake shim); error dedup; handlers never leak messages (canary in thrown error); interaction aggregation; csp violation event simulation.
**Acceptance Criteria:**

- [ ] Only the four registered span shapes are emitted.
- [ ] No message or payload text appears in spans.
- [ ] Error spans are deduplicated per session.

---

## 5.6 Fallbacks and the headless end-to-end test

**Parent:** #5 MCP App
**Task Description:** Degrade gracefully in hosts that cannot support the full app, and test the whole flow in a real browser.
**Expected Inputs:** Reference host (3.1), control-plane stub or real tools.
**Expected Output:** fallback states in `packages/approval-app/src/fallback.ts`, `test/approval-app.int.test.ts` (Playwright).
**Dependencies:** Playwright.
**Items it depends on:** 5.5, 3.7.
**Implementation guidance:**

1. Fallbacks: if the bridge does not connect within 3 s, show "Waiting for host..." then an instruction card with the plain-text `fallbackText` and the CLI commands (`harness approvals approve <id>` / `deny <id>`) with copy buttons (clipboard API guarded; selection fallback). If `harness.approvals.resolve` is unavailable, disable buttons and show the same instruction card.
2. End-to-end tests in the reference host with a real control-plane tool implementation or the stub: approve; deny; edit with invalid then valid value (server validation message by code); reveal flow including the audit event in the event log (`pii_action` with boundary `ui`); expiry; resolve failure; hostile payload with XSS strings and canary values (assert nothing executes and canaries absent from telemetry); fallback rendering when the host drops the bridge.
3. After each decision assert the run log contains the expected `approval_resolved` event and that resuming completes the run.
4. Run in the Azure `integration` stage (Chromium); upload Playwright traces on failure.
**Tests to write:** the Playwright suite above (one test per scenario).
**Acceptance Criteria:**

- [ ] Full approve, deny, and edit flows work end to end in a real browser.
- [ ] Fallback instructions appear when the bridge or tools are unavailable.
- [ ] XSS payloads do not execute and no canary reaches telemetry.

---

## 5.7 Shared UI kit and multi-view build for harness MCP Apps

**Parent:** #5 MCP App
**Task Description:** Give every harness MCP App the same components, theming, accessibility, and security posture, and build each view to its own single-file resource.
**Expected Inputs:** Host context (theme, display mode, locale) from the bridge; views from 5.3, 18.3, 18.8, 16.12, 25.7.
**Expected Output:** `packages/approval-app/src/kit/` (token pills, form renderer for the elicitation form schema, data table, timeline, status badges, meters, confirmation dialog, URL display with domain highlight, empty and error states), `packages/approval-app/src/views/<view>/`, theme tokens mapped from host CSS variables, string catalog `src/kit/strings.ts`, build emitting `dist/<view>.html` per view, docs `docs/apps-ux.md`.
**Dependencies:** `esbuild`, `jsdom`, `axe-core`, `@modelcontextprotocol/ext-apps`.
**Items it depends on:** 5.3, 3.8.
**Implementation guidance:**

1. Components build DOM with `createElement` and `textContent` only (no `innerHTML`), are keyboard accessible, and meet WCAG 2.2 AA contrast in light and dark themes; motion respects `prefers-reduced-motion`.
2. Theme: read host theme and CSS variables from the host context; fall back to built-in light and dark tokens. Layout adapts to inline, fullscreen, and picture-in-picture display modes and to widths down to 320 px.
3. All user-visible strings live in one catalog (English now, ready for translation); numbers, dates, and durations format with the host locale.
4. Build: one esbuild entry per view, each producing a single HTML file with inline script and style, a content hash, and no external URLs (the build fails if any appear). Bundle size budget per view (default 150 KB gzip) enforced in a test.
5. Every view reports the standard UI spans through the shim (5.1, 5.5) and degrades to a text fallback when the bridge is unavailable (5.6).
**Tests to write:** component tests in jsdom (rendering, keyboard navigation, XSS strings rendered as text); axe checks for every component in light and dark themes; display-mode layouts; string catalog completeness (no literal user-visible strings in views, via a lint test); per-view bundle size and external-URL scans.
**Acceptance Criteria:**

- [ ] All harness views share one component kit and theme system.
- [ ] Every view passes accessibility, security, and size checks.
- [ ] Views follow the host's theme and display mode.
