# MCP Apps reference host

The reference host in `@harness/host` loads configured `ui://` resources into a sandboxed iframe. The embedding process supplies a reader connected to the MCP server that owns each resource:

```ts
const host = await createReferenceHost(hostConfig, {
  readResource: (resourceUri) => client.readResource({ uri: resourceUri }),
  onCode: recordHostDiagnosticCode,
});
```

The host validates the resource MIME type (`text/html;profile=mcp-app`) and UTF-8 size (at most 1 MiB). A resource URI not present in `host.apps` returns the code `app_unknown`. The SDK `AppBridge` handles MCP Apps initialization, tool-input and tool-result notifications, and app tool calls. Calls reach the provided handler only when their tool name is in that app's `allowedTools`; the handler remains responsible for the task 3.3 policy decision.

## Local channel

The server binds to `127.0.0.1` by default. `host.listen.host` accepts only loopback addresses, and `host.listen.port` defaults to `0` to request an available local port. The generated per-instance bearer token protects the SSE event stream and resource/call endpoints. `ReferenceHost.url` contains the token in a URL fragment; fragments are not part of HTTP requests, but the URL and token are still sensitive. The embedding CLI should display the launch URL once to the local user and must not send the token to logs or telemetry.

Protected requests require the bearer token and a same-origin `Origin`. Browsers that omit `Origin` on a same-origin GET may use `Sec-Fetch-Site: same-origin`; requests with a foreign `Origin` are rejected. The host does not enable CORS.

## Iframe restrictions

Every app iframe has `sandbox="allow-scripts"` and `referrerpolicy="no-referrer"`. It has no `allow-same-origin`, top-navigation, forms, or popup sandbox grants. The source is assigned through `srcdoc` with the deny-by-default CSP:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'
```

Requested permissions are denied unless named in `host.permissionAllowlist`. CSP domains are reduced to exact origins in `host.cspAllowlist`; unlisted, malformed, and wildcard requests are ignored and reported only with `app_csp_request_ignored`. The default empty allowlist permits no external connections or resources. Allowlisting an origin intentionally grants the corresponding resource types, so only trusted origins should be configured.

This setup assumes a trusted local host page and a browser that enforces iframe sandboxing and CSP. The CSP and sandbox are containment controls, not proof against browser vulnerabilities. App-call policy and host-stamped telemetry are completed by later tasks in epic 3.
