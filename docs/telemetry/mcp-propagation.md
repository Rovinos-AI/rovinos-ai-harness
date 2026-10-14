# MCP trace propagation

Trace context is added to MCP request `_meta` only when a server is configured with
`trust: internal` and `propagateTrace: true`. The propagated `traceparent` and optional
`tracestate` come from the active MCP call span. Callers must invoke `callTool` while that span is
active. Until task 6.5 wires `harness.mcp_call` around production calls, propagation uses whichever
span the caller has active. Other request metadata is preserved, while
`traceparent`, `tracestate`, and `baggage` provided by callers are removed before forwarding
unless replaced by valid trace context for an opted-in internal server.

Trace and span IDs are correlation identifiers: sharing them lets a server correlate requests
with traces in the harness. Configure propagation only for servers trusted to receive those
identifiers. The harness does not send baggage. `tracestate` values longer than 512 characters
are omitted. HTTP server configuration rejects `traceparent`, `tracestate`, and `baggage` header
names case-insensitively, and the HTTP transport also strips them defensively. Schema and captured
request tests cover mixed-case reserved headers for internal and external servers.
