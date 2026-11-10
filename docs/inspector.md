# MCP Inspector

The pinned `@modelcontextprotocol/inspector` CLI can exercise the control-plane HTTP endpoint
without opening the web Inspector. The control plane uses configured bearer tokens rather than an
OAuth authorization server.

Set `MCP_URL` to the `/mcp` endpoint and `CONTROL_PLANE_AUTH_HEADER` to the `Authorization` header
value in standard bearer-token format. Use
`mcp-inspector --cli --server-url "$MCP_URL" --transport http --header "$CONTROL_PLANE_AUTH_HEADER" --method tools/list --format json --quiet --stored-auth-only`
to list tools. The `--stored-auth-only` option keeps this check non-interactive; the explicit
header supplies the control-plane credential. The CLI sends it for initialization and subsequent
MCP requests.

To check the unauthenticated path, omit `--header` and retain `--stored-auth-only`. The endpoint
rejects the request before MCP handling; the CLI reports `auth_required` and exits with status 3.

The integration gate also invokes the synthetic `list_runs` tool over stdio and HTTP, rejects
malformed arguments and an unknown tool, and checks that the MCP App visibility metadata matches
the negotiated client capability. A second HTTP token has only `read` scope: its permitted
`list_runs` call succeeds. A guessed App-only call without Apps negotiation fails with the JSON-RPC
`tool_not_found` error; the same error is returned for a guessed `start_run` call because the
restricted principal's `tools/list` omits tools outside its scope. The run list is compared before
and after the denied mutation to confirm it did not create a run. Inspector exit statuses are
interpreted by failure type; in particular, its documented status 3 is the unauthenticated path,
status 5 is an MCP tool error, and protocol errors are asserted from their error envelope rather
than treated as tool errors.

For an endpoint that implements MCP OAuth, first authorize that server using the Inspector UI so its
OAuth credentials are stored in the shared Inspector credential store. Then run the CLI with
`--use-stored-auth --stored-auth-only` and the same `--server-url`; the CLI reuses the stored
credential without prompting or opening a browser. This OAuth flow does not apply to the
control-plane's static bearer tokens.

Avoid placing token values directly in command history or checked-in configuration. Configure
`controlPlane.auth.tokens[].secret` with a `SecretRef` and expose its corresponding value only in the
local environment used to launch the Inspector.

## Browser Apps verification

The integration test `test/inspector-apps.int.test.ts` runs the pinned Inspector 2.13.0 web client
against the harness over loopback HTTP using the 2026-07-28 protocol era and an approve-scoped
synthetic token. It covers rendered approval details, read-only approval lookup and resource reads,
an already-resolved approval, canary/network checks, and that approve/deny calls fail closed with
`human_confirmation_unavailable` without recording a decision. Inspector does not provide a
verifiable per-call app-origin assertion or relay confirmation for these calls. Resolving approvals
therefore requires a host that forwards a verifiable app-origin signal or supports confirmation;
this follow-up is tracked in [#768](https://github.com/Rovinos-AI/rovinos-ai-harness/issues/768).
Run it with
`yarn test:integration test/inspector-apps.int.test.ts`; CI executes it in the `integration` job with
Chromium. Inspector credentials use the memory secret store and an isolated home directory.

This is browser-host coverage of the harness control-plane, not an upstream protocol conformance
claim or a test of model-selected outbound MCP calls.

## Advisory MCP conformance lanes

The separate GitHub Actions `conformance-advisory` job runs the official
`@modelcontextprotocol/conformance@0.2.0-alpha.12` runner against protocol `2026-07-28`. The pinned
release is MIT-licensed and contains the frozen requirements inventory for that protocol revision.
The role adapters exercise the harness `McpToolPort` client with `tools_call`, and the actual
control-plane server with `server-stateless` and `tools-list`. The server adapter uses a loopback-only
proxy to supply its synthetic admin bearer token; the conformance runner and archived reports do not
receive that token.

| Role | Implemented behavior in scope | Conformance scenarios measured |
| --- | --- | --- |
| Client | Tool discovery and calls through `McpToolPort`; stdio and HTTP transports are supported, while this lane exercises HTTP. | `tools_call` |
| Server | Control-plane tools and resources over stdio and HTTP; Apps visibility is capability-negotiated, while this lane exercises HTTP. | `server-stateless`, `tools-list` |

The report records the runner and protocol revisions, each measured scenario result, every required
scenario left `not_measured`, and the runner's `not_scored` cases and reasons. The initial matrix
does not claim prompts, resource templates, task extensions, OAuth-client scenarios, or other
unmeasured capabilities as implemented. Static bearer-token expiry and in-process revocation are
unsupported and explicitly marked not measured. Inspector interoperability results remain separate
from the conformance report; neither constitutes universal MCP certification.

This lane is advisory and does not feed the required `gates` job. Promote it to blocking only after
the owner reviews the reported failures and coverage, approves the expanded capability matrix, and
updates the pinned runner deliberately. Scenario failures are retained in the uploaded report and
emitted as GitHub Actions warnings; runner, setup, and report-validation errors still fail the job.
The current `server-stateless` failure remains a follow-up for capability-matrix review.

Verification decision: GitHub Actions is the current CI; the integration tests map to its
`integration` job, and the new role lanes use a separate non-required job. The retired Azure pipeline
has no active stage to update.
