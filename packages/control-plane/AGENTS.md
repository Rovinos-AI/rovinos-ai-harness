# AGENTS.md: packages/control-plane

Harness-as-MCP-server: list/get runs, approvals, resume/cancel, runs console app, auth.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [epic-18-control-plane-mcp-server.md](./epic-18-control-plane-mcp-server.md): tasks 18.1-18.8

## Allowed internal imports
- `@harness/schemas`, `@harness/telemetry`, `@harness/crypto`, `@harness/store`, `@harness/vault`, `@harness/pii`, `@harness/models`, `@harness/context`, `@harness/policy`, `@harness/mcp`, `@harness/sandbox`, `@harness/core`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).
<!-- END GENERATED: agents-index -->

## Rules
- Metadata only in tool outputs. Content exists only in approvals (tokenized) and the audited reveal.
- An agent must never approve its own actions: approve/deny are app-only and require human elicitation confirmation otherwise; fail closed.
- Bearer tokens with scopes; loopback by default; non-loopback requires TLS; check Host/Origin.
- Omit app-only tools from `tools/list` for clients without UI support.

## Testing
- In-memory client/server tests; compatibility matrix integration test.
