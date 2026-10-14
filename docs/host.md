# MCP Apps reference host

The reference host in `@harness/host` loads configured `ui://` resources into a sandboxed iframe. The embedding process supplies a reader connected to the MCP server that owns each resource:

```ts
const host = await createReferenceHost(hostConfig, {
  readResource: (resourceUri) => client.readResource({ uri: resourceUri }),
  onCode: recordHostDiagnosticCode,
});
```

The host validates the resource MIME type (`text/html` with the exact `profile=mcp-app` parameter, allowing MIME casing and whitespace) and UTF-8 size (at most 1 MiB). A resource URI not present in `host.apps` returns the code `app_unknown`. Each launch receives a fresh ULID session ID. `host.maxUiSessions` defaults to 32 active sessions per host; further launches receive `app_session_limit` until an active session ends. `host.uiSessionMaxMs` defaults to 3,600,000 ms; expired sessions are ended, removed, and reported as `ui_session_expired`. The SDK `AppBridge` handles MCP Apps initialization, tool-input and tool-result notifications, and app tool calls. Calls are accepted only when their tool name is in that app's `allowedTools`. Supplying both `policy` and `tool` creates the default policy-checked handler: arguments are prepared through the tool port and policy sees `{ subagent: false, app: app.id }`. `deny` returns the rule reason without executing; `ask` returns `app_call_requires_approval` without executing. App-call approval suspension is a follow-up. An explicitly supplied `onAppCall` overrides this default and is responsible for preserving policy enforcement.

Telemetry calls remain local to the host. The default `harness.telemetry.emit` handler checks the serialized payload limit (16 KiB), the 50-span batch limit, and strict schemas for `ui.render`, `ui.decision`, `ui.error`, and `ui.interaction`. Each app session has a token bucket allowing a burst of 20 batches and a sustained rate of 10 batches per second; a batch over that rate returns `rate_limited`. `host.limits` can override `batchesPerSecond`, `batchBurst`, `spansPerMinute` (default 200), and `spansPerSessionLifetime` (default 2,000). Spans over either span cap are silently dropped and counted as `session_cap`; invalid spans are dropped independently and counted with bounded reasons. The handler returns only `{ accepted, dropped }`, and the metrics do not include app or session IDs. Attributes on accepted spans come from validated fields; the default handler does not include the raw app payload in spans or its acknowledgment. A host-supplied `onTelemetryEmit` callback replaces that default and is responsible for applying the same validation and limits, returning only that acknowledgment, and keeping app payloads local.

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
