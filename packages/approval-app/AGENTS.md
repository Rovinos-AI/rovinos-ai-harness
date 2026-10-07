# AGENTS.md: packages/approval-app

All harness MCP App views (approval, human input, run console, run inspector, reports) and their shared UI kit, each built to a single HTML file served as `ui://harness/<view>/v1` with MIME type `text/html;profile=mcp-app`.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [epic-05-mcp-app.md](./epic-05-mcp-app.md): tasks 5.1-5.7

## Allowed internal imports
- `@harness/schemas`, `@harness/app-telemetry`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).
<!-- END GENERATED: agents-index -->

## Also touched by
- 18.3 (runs console view), 18.8 (run inspector view), 16.12 (reports view), 25.7 (input view): specs in their own epics; views live under `src/views/` and use the kit from 5.7.

## Boundaries
- Browser code: import only browser-safe exports; no Node APIs.

## Rules
- Build DOM with `createElement`/`textContent` only. Never `innerHTML`, `eval`, or inline event attributes.
- Single-file build with no external URLs (the build fails if it finds one).
- Shows tokenized values by default. Reveal is explicit, confirmed, audited server-side, and auto-masks after 30 s.
- Accessibility is required: axe checks must pass.

## Testing
- jsdom unit tests incl. XSS payloads; Playwright end-to-end in the integration stage.
