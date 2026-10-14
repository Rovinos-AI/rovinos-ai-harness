# Control-plane decision security

`approve` and `deny` are marked app-only so a compliant MCP Apps host can keep them out of the
model's tool list. That visibility metadata is enforced by the host, not by the MCP server. A host
that exposes these tools to a model does not satisfy the control-plane trust assumption.

The pinned MCP server SDK does not provide a trusted app-origin marker to a tool handler. The
control plane skips elicitation only when its embedding host supplies an `isAppContext` assertion
based on host-controlled app-session metadata. The assertion must not be based on client-supplied
tool arguments or ordinary request metadata. Without the assertion, calls require accepted human
elicitation; clients without form elicitation fail closed.

Elicitation retries carry SDK HMAC-sealed request state bound to the client/token identity, tool,
argument digest, and approval or run id. State expires after five minutes and can be consumed only
once per process. The SDK's legacy shim preserves the same decision gate for 2025-era connections.
Approval decisions are recorded separately from resumption; use `resume_run` to continue a run.
