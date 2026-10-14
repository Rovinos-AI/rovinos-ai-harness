# Control-plane decision security

`approve` and `deny` are marked app-only so a compliant MCP Apps host can keep them out of the
model's tool list. That visibility metadata is enforced by the host, not by the MCP server. A host
that exposes these tools to a model does not satisfy the control-plane trust assumption.

Decision tools assume a human-facing MCP client. Form elicitation is a user-interface request, not
proof of a human decision: an automated client that advertises `elicitation.form` and submits
`confirm: true` can bypass the intended human review. Only connect trusted human-facing clients to
the decision tools. Remote exposure requires the authentication and run-scoping protections from
18.5 (#178); until then, `harness serve` is a single-instance, loopback-only service.

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
