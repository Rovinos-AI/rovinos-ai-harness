# AGENTS.md: packages/mcp

MCP client and tool bridge: connections, registry, trace propagation, result mapping.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-06-mcp-servers.md](./epic-06-mcp-servers.md): tasks 6.1-6.8
- [epic-25-elicitation-and-human-input.md](./epic-25-elicitation-and-human-input.md): tasks 25.1-25.8

## Allowed internal imports

- `@harness/schemas`, `@harness/telemetry`, `@harness/crypto`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Rules

- Servers are untrusted: normalize tool names, cap and sanitize descriptions, never copy server error text into codes, spans, or logs.
- Trace context goes only to `trust: internal` servers with `propagateTrace: true`, only in `params._meta`, never baggage.
- Stdio servers do not inherit the parent environment.
- Validate tool arguments against the tool's input schema before any network I/O.
- Elicitation (epic 25) is off per server unless configured. Declare only configured modes, bind every request to one in-flight tool call, decline secret-seeking forms, never fetch or open elicitation URLs, and hand requests to `ElicitationPort`; the human-input broker lives in `core`.

## Testing

- In-memory transport unit tests; the sample server container for integration (`test/fixtures/sample-mcp-server`).
