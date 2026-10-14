# Sandbox egress

The sandbox runner has no external network route by default. Its default Compose attachment is the internal `sandbox` network used to reach the harness. The `sandbox-egress` network is internal as well; it connects the runner to the egress proxy only. The proxy alone also joins `egress`, which has an external route. The proxy is in the `sandbox-egress` Compose profile and is not started by the default sandbox profile.

## Configure an allowlist

Use exact host names and explicit ports in the harness configuration:

```yaml
sandbox:
  egress:
    allow:
      - host: api.example.com
        ports: [443]
```

Run the sandbox Compose wrapper from the repository root. It loads the harness config, serializes `sandbox.egress.allow` into `SANDBOX_EGRESS_ALLOW`, and selects the egress overlay only when the list is non-empty:

```sh
SANDBOX_RUNNER_TOKEN="$(cat /secure/sandbox-runner-token)" \
  yarn compose:sandbox up --detach --build sandbox-runner sandbox-egress-proxy
```

With an empty or absent allowlist, the wrapper uses only the base Compose file and `sandbox` profile. The runner starts with no proxy variables and the proxy service is not started. With a non-empty allowlist, the wrapper passes it to Compose and enables the `sandbox-egress` profile. The proxy validates its configuration at startup and exits if the list is invalid.

For runtime execution, also configure `sandbox.runner.url` and its token reference as described in [Configuration](configuration.md#sandbox-egress). The URL must identify the runner started by this wrapper with the same allowlist configuration and egress overlay. `createRuntime` resolves the token and shares one remote backend with tool adapters; it does not deploy or verify Compose networks. A non-empty allowlist without a runner is rejected rather than executed locally.

The runner injects both uppercase and lowercase HTTP/HTTPS proxy variables into each command and removes `NO_PROXY` and `no_proxy`, so commands cannot exempt destinations from proxy enforcement.

The proxy supports HTTP forwarding and HTTP CONNECT. It matches normalized host names and ports exactly, resolves the requested destination once, rejects the entire DNS answer set if any address is loopback, link-local/metadata, private or shared (`100.64.0.0/10`), in `192.0.0.0/24` or `198.18.0.0/15`, IPv6 unique-local/site-local/discard-only, Teredo, or multicast, and connects to the first validated resolved IP. Embedded IPv4 addresses in mapped IPv6, NAT64, and 6to4 addresses receive the same checks. Public IP literals are accepted only when explicitly listed. Wildcard and private IP-literal entries fail startup validation.

Proxy output contains only `egress_allowed` / `egress_denied` counters and bounded reason codes. It does not emit hostnames, request paths, or URLs. The allowlist and proxy route are the egress boundary: a child that ignores proxy variables still has no direct external route.

## `web.fetch`

The built-in `web.fetch` provider sends requests to the runner's authenticated `POST /fetch` endpoint. The runner performs the request through the configured egress proxy; the harness never makes the public web request itself. `createWebFetchTool` returns no tool when the allowlist is absent or empty. The runner also refuses the endpoint unless both the proxy and a non-empty allowlist are configured.

The tool accepts `url`, an optional `accept` value (`text/html`, `text/plain`, `text/markdown`, or `application/json`), and optional `stripQuery` (defaults to `true`). Requests are GET-only, use a fixed user agent, and send no cookies, credentials, or authentication headers. HTTPS is required except for allowlisted `.test` and localhost hosts used by local tests. Each redirect is checked against the exact host/port allowlist before the next request, and the proxy independently resolves and blocks private, link-local, metadata, and other special-use addresses. More than five redirects, a disallowed destination, or a failed proxy request returns a bounded error code without echoing the URL.

The runner enforces a 20-second total deadline and reads at most 2 MiB of response bytes. HTML becomes visible text: scripts, styles, templates, and hidden elements are omitted; `hiddenTextDropped` reports the number of omitted hidden text characters. Plain text, Markdown, and JSON are returned as text. Other media types return `{ binary: true, contentType, bytes }`, where `bytes` is a bounded array of byte values. Results include the final URL, status, content type, truncation state, and `untrusted: true`; the query string is removed from the result URL by default. When composed through the standard tool boundary, content is tokenized before durable storage and large results use the workspace offload path. The provider does not create spans or log request URLs.

The provider is available from `@harness/sandbox`; registration into the shipped runtime and CLI is not yet wired. Applications should only register it with a `RemoteSandboxBackend` configured against a runner started with the same non-empty allowlist and egress overlay.
