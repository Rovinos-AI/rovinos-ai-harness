# MCP trace propagation

Trace context is added to MCP request `_meta` only when a server is configured with
`trust: internal` and `propagateTrace: true`. The propagated `traceparent` and optional
`tracestate` come from the active call span. Other request metadata is preserved, while
`traceparent`, `tracestate`, and `baggage` provided by callers are removed before forwarding
unless replaced by valid trace context for an opted-in internal server.

Trace and span IDs are correlation identifiers: sharing them lets a server correlate requests
with traces in the harness. Configure propagation only for servers trusted to receive those
identifiers. The harness does not send baggage. `tracestate` values longer than 512 characters
are omitted.
