# MCP Apps reference host

The reference host in `@rovinos/host` loads configured `ui://` resources into a sandboxed iframe. The embedding process supplies a reader connected to the MCP server that owns each resource:

```ts
const host = await createReferenceHost(hostConfig, {
  readResource: (resourceUri) => client.readResource({ uri: resourceUri }),
  onCode: recordHostDiagnosticCode,
});
```

The host validates the resource MIME type (`text/html` with the exact `profile=mcp-app` parameter, allowing MIME casing and whitespace) and UTF-8 size (at most 1 MiB). A resource URI not present in `host.apps` returns the code `app_unknown`. Each launch receives a fresh ULID session ID. `host.maxUiSessions` defaults to 32 active sessions per host; further launches receive `app_session_limit` until an active session ends. `host.uiSessionMaxMs` defaults to 3,600,000 ms; expired sessions are ended, removed, and reported as `ui_session_expired`. The SDK `AppBridge` handles MCP Apps initialization, tool-input and tool-result notifications, and app tool calls. Calls are accepted only when their tool name is in that app's `allowedTools`. Supplying both `policy` and `tool` creates the default policy-checked handler: arguments are prepared through the tool port and policy sees `{ subagent: false, app: app.id }`. `deny` returns the rule reason without executing. For `ask`, supply `onAppCallApproval` to persist a pending core approval, suspend and resume the run, and return the resulting tool result (or a typed denial/expiry error) to the app. The callback receives the already-prepared call and policy decision so its runtime adapter can reuse durable approval, edit re-evaluation, and resume handling. Hosts without that durable approval/resume integration fail closed with `app_call_requires_approval`. An explicitly supplied `onAppCall` overrides this default and is responsible for preserving policy enforcement.

Telemetry calls remain local to the host. The default `harness.telemetry.emit` handler checks the serialized payload limit (16 KiB), the 50-span batch limit, and strict schemas for `ui.render`, `ui.decision`, `ui.error`, `ui.interaction`, and `ui.input`. Input spans contain only the bounded `action` enum. Each app session has a token bucket allowing a burst of 20 batches and a sustained rate of 10 batches per second; a batch over that rate returns `rate_limited`. `host.limits` can override `batchesPerSecond`, `batchBurst`, `spansPerMinute` (default 200), and `spansPerSessionLifetime` (default 2,000). Spans over either span cap are silently dropped and counted as `session_cap`; invalid spans are dropped independently and counted with bounded reasons. The handler returns only `{ accepted, dropped }`, and the metrics do not include app or session IDs. Attributes on accepted spans come from validated fields; the default handler does not include the raw app payload in spans or its acknowledgment. A host-supplied `onTelemetryEmit` callback replaces that default and is responsible for applying the same validation and limits, returning only that acknowledgment, and keeping app payloads local.

## App-call approvals

Runtime-backed hosts supply `runtime.onAppCallApproval`. An app call that matches an `ask` rule records
the prepared, tokenized call as a tool intent and one pending approval, then
suspends the run using the same durable approval/checkpoint path as model tool
calls. The app's call remains pending until the approval is resolved and the
run resumes.

Approve through the normal approval interface, then resume the run (or enable
automatic resume). Policy is evaluated again before execution, including when
the human edits arguments or the process restarts after approval. The app
receives the recorded tool result. Denial and expiry return typed errors
instead of executing the tool.

`app_call_requires_approval` is still returned when the host has no durable
approval callback or its tool port has no sanitizing
`prepare` step. In particular, the host never delegates raw arguments to a
durable approval callback when preparation is unavailable.
The runtime returns `app_run_unavailable` if the bound run is unavailable or
cannot accept a new approval in its current state.

## Local channel

The server binds to `127.0.0.1` by default. `host.listen.host` accepts only loopback addresses, and `host.listen.port` defaults to `0` to request an available local port. One generated bearer token is cached per Node process and protects every reference-host instance in that process. A leak therefore compromises all those host instances. `ReferenceHost.url` contains the token in a URL fragment; fragments are not part of HTTP requests, but the URL and token are still sensitive. The embedding CLI should display the launch URL once to the local user and must not send the token to logs or telemetry.

Every request must use the loopback `Host` value for the selected port (`127.0.0.1:<port>`, `[::1]:<port>`, or `localhost:<port>`). Protected requests also require the bearer token and a same-origin `Origin`. Browsers that omit `Origin` on a same-origin GET may use `Sec-Fetch-Site: same-origin`; requests with a foreign `Origin` are rejected. The host does not enable CORS.

The host page and bundle are served with a restrictive CSP, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`. The parent CSP blocks nested frames from loading outside its own loopback origin, preventing apps from sending data outside by redirecting themselves. The `srcdoc` app's own CSP limits other resources and connections to its policy, which can include only explicitly allowlisted domains. Forms and nested frames are denied. The iframe is titled with its validated app ID for assistive technology.

## Iframe restrictions

Every app iframe has `sandbox="allow-scripts"` and `referrerpolicy="no-referrer"`. It has no `allow-same-origin`, top-navigation, forms, or popup sandbox grants. The source is assigned through `srcdoc` with the deny-by-default CSP:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'
```

Requested permissions are denied unless named in `host.permissionAllowlist`. CSP domains are reduced to exact origins in `host.cspAllowlist`; unlisted, malformed, and wildcard requests are ignored and reported only with `app_csp_request_ignored`. The default empty allowlist permits no external connections or resources. Allowlisting an origin intentionally grants the corresponding resource types, so only trusted origins should be configured.

`host.apps[].telemetry` defaults to `false`. When enabled, the host sends the app a W3C `traceparent` in the tool-result notification metadata, correlated with the originating tool-call span. The trace ID is visible to app code and is a correlation identifier, not a secret; only apps explicitly configured with `telemetry: true` receive it. No `tracestate` or `baggage` is sent. Supply the owning run ID and tool-call span context with `uiSessionContext`; call `ReferenceHost.endUiSessions()` when that run resumes. A missing or invalid span context omits the metadata and reports only `ui_trace_unavailable`.

This setup assumes a trusted local host page and a browser that enforces iframe sandboxing and CSP. The CSP and sandbox are containment controls, not proof against browser vulnerabilities. App-call policy and host-stamped telemetry are completed by later tasks in epic 3.

## UX

### Approval screen (task 5.3)

`yarn workspace @rovinos/approval-app build` produces `packages/approval-app/dist/approval.html`,
a single document with inline script/style and a SHA-256 content comment. The view validates
tool-input arguments, structured tool results, or JSON text results against the shared
`ApprovalPayloadSchema` (`@rovinos/schemas/browser`). Invalid payloads replace the screen with
a fixed error state and report only `ui.error` / `payload_invalid` through the host.

The screen displays tokenized arguments as a collapsible tree. Pills label entity types and
retain the exact token as their accessible name; the app does not resolve tokens or store
payloads in browser storage. Expiry is checked on receipt and every second, disabling all
actions when elapsed. The heading receives focus, status changes use a live region, and the
layout supports narrow screens, light/dark preferences, and reduced motion.

This task renders the buttons only: decision/edit/reveal handlers belong to task 5.4, and
serving the resource and approval tools belongs to task 18.4 (#207). No decision is sent yet.
The build rejects app-owned external URLs and scans the final HTML for HTTP(S) literals.
SDK documentation/schema URL separators are escaped during inline serialization without
changing their runtime string values; these are not resource requests. The sandbox/CSP
remains the network boundary. Unit tests cover XSS, metadata-only errors, artifact references,
and axe states; palette contrast is checked separately because jsdom has no layout engine.

The reference host sends MCP Apps host context during `ui/initialize` and pushes host-context updates when the viewport, fullscreen state, locale, or preferred color scheme changes. Context includes the light or dark theme, the SDK's documented CSS variables, locale, time zone, current and available display modes, and maximum container dimensions. App size-change requests are clamped to those dimensions (at most 1024 by 768 CSS pixels, and no larger than the viewport). The host supports inline mode and fullscreen when the browser enables it. It does not advertise picture-in-picture because this reference host does not implement PiP iframe handling.

## App requests

`host.apps[].allow` opts an individual app into requests that open external links or add model messages/context. All three flags default to `false`:

```yaml
apps:
  - id: reference-app
    resourceUri: ui://reference/app
    allowedTools: []
    allow:
      openLink: true
      message: false
      modelContext: false
```

An opted-in `ui/open-link` request still requires explicit consent in the host page. The consent dialog shows the full URL, highlights its registrable domain, and warns when the hostname uses punycode; consent opens it in a new browser tab, not inside the harness. Only HTTP(S) URLs without embedded credentials are eligible.

`ui/message` and `ui/update-model-context` remain separate opt-ins. The embedding runtime must provide both `tokenizeAppContent` and `onAppContent`; otherwise the requests fail closed with `request_unavailable`. The tokenizer receives the JSON content at the `model_input` boundary, and the recorder callback receives only the tokenized content with the app ID and the `App-provided` label. Embeddings should record this as untrusted content in the transcript; app requests do not resolve approvals or supply tool input. The reference host does not wire these callbacks into the CLI/runtime yet (-> #207).

Rejected or unavailable requests are counted with bounded reason codes. Request payloads and tokenizer/recorder error messages are not included in those counters or host diagnostics. App tool calls continue to use the separate `allowedTools` and policy path described above.
