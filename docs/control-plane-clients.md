# Control-plane client compatibility

The control plane supports MCP 2026-07-28 and legacy 2025-11-25 clients through
the MCP TypeScript SDK v2. The integration matrix exercises each client profile
in both protocol eras.

| Client profile | App-only tools in `tools/list` | Read tools | Approval path | Model-visible decision attempt |
| --- | --- | --- | --- | --- |
| SDK client without UI or elicitation | Omitted | `list_runs` and `get_run` return run metadata | CLI instructions from `review_approval` | Fails closed with `human_confirmation_unavailable` |
| SDK client with elicitation only | Omitted | `list_runs` and `get_run` return run metadata | Human elicitation through `review_approval`, followed by confirmed resume | Requires an explicit human elicitation; a declined confirmation does not resolve the approval |
| Reference-host MCP Apps client | Included only when the UI extension advertises `text/html;profile=mcp-app` | `list_runs` and `get_run` return run metadata; app-visible copies are available to the console | Approval app via `harness.approvals.resolve` | App-only decision tools are hidden from the model-visible list |

The compatibility test uses the SDK's legacy negotiation mode for
2025-11-25 and pins 2026-07-28 for the modern era. The reference-host app flow
is also exercised in Chromium by `test/approval-app.int.test.ts`.

The `list_runs` and `get_run` tool results contain metadata and a plain-text
summary; they do not return app HTML. App-only approval, input, and duplicated
run-inspection tools are omitted unless the exact MCP Apps extension and MIME
type are advertised. Other than the SDK v2 clients and the reference host
covered by repository tests, third-party client behavior is **unverified**.

## Human input

`list_pending_inputs` requires `read` scope and returns request metadata only.
`get_input` requires `approve` scope and returns the tokenized message and form or
URL details. `answer_input` is app-only; `review_input` is model-visible but
requires a human elicitation before resolving the pending request. It uses the
connected client's per-request form or URL capability and reports CLI
instructions when that mode is unavailable.

The relay identifies the original server and run in the elicitation message.
Its sealed request state binds the retry to the authenticated token and input
request, expires after five minutes, and is consumed once. The SDK's
2025-11-25 legacy shim and 2026-07-28 multi-round-trip flow use the same
human-resolution path. Answers record the authenticated token principal when
available, or the local control-plane principal for an unauthenticated local
connection.
