# MCP Apps reference host

The reference host in `@harness/host` loads configured `ui://` resources into a sandboxed iframe. The embedding process supplies a reader connected to the MCP server that owns each resource:

```ts
const host = await createReferenceHost(hostConfig, {
  readResource: (resourceUri) => client.readResource({ uri: resourceUri }),
  onCode: recordHostDiagnosticCode,
});
```

The host validates the resource MIME type (`text/html` with the exact `profile=mcp-app` parameter, allowing MIME casing and whitespace) and UTF-8 size (at most 1 MiB). A resource URI not present in `host.apps` returns the code `app_unknown`. Each launch receives a fresh ULID session ID. The SDK `AppBridge` handles MCP Apps initialization, tool-input and tool-result notifications, and app tool calls. Calls reach the provided handler only when their tool name is in that app's `allowedTools`; the handler remains responsible for the task 3.3 policy decision.

## Local channel

The server binds to `127.0.0.1` by default. `host.listen.host` accepts only loopback addresses, and `host.listen.port` defaults to `0` to request an available local port. One generated bearer token is cached per Node process and protects every reference-host instance in that process. A leak therefore compromises all those host instances. `ReferenceHost.url` contains the token in a URL fragment; fragments are not part of HTTP requests, but the URL and token are still sensitive. The embedding CLI should display the launch URL once to the local user and must not send the token to logs or telemetry.

Every request must use the loopback `Host` value for the selected port (`127.0.0.1:<port>`, `[::1]:<port>`, or `localhost:<port>`). Protected requests also require the bearer token and a same-origin `Origin`. Browsers that omit `Origin` on a same-origin GET may use `Sec-Fetch-Site: same-origin`; requests with a foreign `Origin` are rejected. The host does not enable CORS.

The host page and bundle are served with a restrictive CSP, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`. The parent CSP limits nested documents to its own loopback origin so an app cannot exfiltrate by navigating itself; the `srcdoc` app's own CSP further denies network connections, forms, and nested frames. The iframe is titled with its validated app ID for assistive technology.

## Iframe restrictions

Every app iframe has `sandbox="allow-scripts"` and `referrerpolicy="no-referrer"`. It has no `allow-same-origin`, top-navigation, forms, or popup sandbox grants. The source is assigned through `srcdoc` with the deny-by-default CSP:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'
```

Requested permissions are denied unless named in `host.permissionAllowlist`. CSP domains are reduced to exact origins in `host.cspAllowlist`; unlisted, malformed, and wildcard requests are ignored and reported only with `app_csp_request_ignored`. The default empty allowlist permits no external connections or resources. Allowlisting an origin intentionally grants the corresponding resource types, so only trusted origins should be configured.

`host.apps[].telemetry` defaults to `false` and is reserved for task 3.2's opt-in UI-session trace propagation. Task 3.1 does not emit app telemetry based on this setting.

This setup assumes a trusted local host page and a browser that enforces iframe sandboxing and CSP. The CSP and sandbox are containment controls, not proof against browser vulnerabilities. App-call policy and host-stamped telemetry are completed by later tasks in epic 3.
