# Control-plane security

`approve` and `deny` are marked app-only so a compliant MCP Apps host can keep them out of the
model's tool list. That visibility metadata is enforced by the host, not by the MCP server. A host
that exposes these tools to a model does not satisfy the control-plane trust assumption.

Decision tools assume a human-facing MCP client. Form elicitation is a user-interface request, not
proof of a human decision: an automated client that advertises `elicitation.form` and submits
`confirm: true` can bypass the intended human review. Only connect trusted human-facing clients to
the decision tools.

## HTTP authentication and network binding

HTTP mode requires at least one configured token. Each `controlPlane.auth.tokens` entry has a
`Code` id, a `SecretRef`, one or more scopes, and an optional `runIds` allowlist. The secret is
resolved at startup; only its SHA-256 digest is kept for request verification. Comparisons use
fixed-size SHA-256 digests and `timingSafeEqual`. Missing and invalid credentials receive the same
401 response before MCP dispatch, including for `initialize`, `tools/list`, and `tools/call`.
Credentials are not included in audit records or response bodies.

The default listener is `127.0.0.1:3000`, with loopback hostnames allowed by default. A non-loopback
bind is rejected unless `controlPlane.tls` supplies `certFile` and `keyFile` SecretRefs; in that
case the server starts an HTTPS listener using the resolved certificate and key. Set
`controlPlane.allowedHosts` to the hostnames clients will use. Requests with a Host outside that
allowlist or a mismatched Origin are rejected before MCP handling. An absent Origin is allowed for
non-browser MCP clients; browser requests with an Origin must match the request host and listener
scheme.

`controlPlane.rateLimitPerMinute` configures an in-memory token bucket per token (default 120
requests/minute). The bucket uses the injected clock and applies to every authenticated HTTP
request. Limits are local to one server process.

## Scopes, runs, and audit

`read` grants `list_runs` and `get_run`; `approve` grants `approve`, `deny`, and
`harness.approvals.resolve`; `run` grants `resume_run` and `cancel_run`; and `reveal` grants
`harness.approvals.reveal`. `read_content` is reserved for the tokenized run-inspector content
operation in task 18.8. `admin` grants all current scopes. `tools/list` omits tools outside the
token's scopes. A token with `runIds` can list only those runs and cannot inspect, approve, reveal,
resume, or cancel another run. Omitting `runIds` grants access to every run for the token's scopes.

Authenticated tool calls emit metadata-only audit records with `tokenId`, `tool`, and `outcome`
codes. The log does not contain bearer values, run content, tool arguments, or error messages.
Stdio mode is treated as trusted local access and does not require a bearer token.

The pinned MCP server SDK does not provide a trusted app-origin marker to a tool handler. The
control plane skips elicitation only when its embedding host supplies an `isAppContext` assertion
based on host-controlled app-session metadata. The assertion must not be based on client-supplied
tool arguments or ordinary request metadata. `isAppContext` remains `false` unless a trusted host
explicitly asserts app provenance. Without the assertion, calls require accepted human elicitation;
clients without form elicitation fail closed.

Elicitation retries carry SDK HMAC-sealed request state bound to the client/token identity, tool,
argument digest, and approval or run id. State expires after five minutes and can be consumed only
once through the event store, including across server restarts and instances sharing the same
database. The default HMAC key is generated per process, so outstanding requests fail closed after
a restart; multi-instance serving is not supported by `harness serve`. The SDK's legacy shim
preserves the same decision gate for 2025-era connections. Approval decisions are recorded
separately from resumption; use `resume_run` to continue a run.

(verify) MCP SDK 2.3.1 does not expose trusted app-origin provenance to tool handlers. App bypass
therefore remains gated on an explicit assertion from the embedding host.
