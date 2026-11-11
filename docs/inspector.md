# MCP Inspector

The repository pins MCP Inspector **2.14.0**. Its web client, TUI, CLI, and experimental
`mcpdo` client can connect to the harness control-plane, a test MCP server, or a separately
configured MCP server. Inspector is an MCP client: connecting directly to an outbound server does
not exercise a model-selected call through the harness.

## Coverage and limits

| Surface or check | Current coverage |
| --- | --- |
| CLI gate | `test/inspector-conformance.int.test.ts` exercises `harness serve` over stdio and HTTP, modern and legacy initialization, schema portability, Apps metadata and HTML retrieval, synthetic tool calls, restricted read scope, unauthenticated HTTP rejection, and a credential-leak canary. |
| Web Apps | `test/inspector-apps.int.test.ts` uses Inspector 2.14.0 against a synthetic loopback server and checks rendered approval content and privacy/network controls. Decision calls fail closed with `human_confirmation_unavailable`; this scenario does not verify a completed approval or denial. |
| TUI | Available for terminal-only inspection; no harness-specific TUI scenario is currently run by CI. |
| `mcpdo` | Experimental persistent client sessions; use only for advisory exploration. There is no harness-specific `mcpdo` result in the blocking CI gate. |

These are harness-server checks, not upstream MCP certification or a test of model-selected outbound
calls. The advisory conformance lane and its measured roles are described below.

## Connect

Use synthetic data and a local development configuration. Start the harness in one terminal with
`harness serve --stdio` for a local process transport, or `harness serve --http --port 3000` for
loopback HTTP. HTTP prints the MCP endpoint (normally `http://127.0.0.1:3000/mcp`) and requires a
configured control-plane bearer token. See [Control-plane security](control-plane-security.md) for
token scopes and `SecretRef` setup. Stdio is trusted local access and does not use HTTP
authentication.

For stdio, the CLI can launch the harness directly, for example:
`mcp-inspector --cli node packages/cli/dist/bin.js serve --stdio -- --protocol-era modern --method tools/list --format json`.
Use the built CLI and your local harness configuration. For HTTP, set `MCP_URL` to the `/mcp`
endpoint and `CONTROL_PLANE_AUTH_HEADER` to a locally supplied bearer `Authorization` header, then
run:
`mcp-inspector --cli --server-url "$MCP_URL" --transport http --protocol-era modern --header "$CONTROL_PLANE_AUTH_HEADER" --method tools/list --format json --quiet --stored-auth-only`.
Replace `modern` with `legacy` to check the other protocol era. `--stored-auth-only` prevents an
interactive auth flow; it does not supply the harness bearer token.

For the **6.7 sample server**, use `test/fixtures/sample-mcp-server` on its test Compose network
(streamable HTTP port 3333). It is a synthetic test fixture, not a public endpoint; connect from a
client on that network. Its `echo` tool returns its input and `send_message` updates a test counter,
so keep calls synthetic and avoid the mutating tool unless the test requires it.

To inspect an independently configured MCP server, add it to Inspector's own `--config` or
`--catalog`. Those are Inspector connection files, not the harness `HARNESS_CONFIG`; credentials and
server configuration are not automatically shared. For OAuth configured in the harness, see the
[MCP server authorization recipe](mcp-servers.md#authorization).

## Choose an Inspector surface

### Web client

Start `mcp-inspector --web` and connect to the loopback HTTP endpoint, or select a server in the
Inspector catalog. The **Tools** tab is for listing and manually exercising tools; **Apps** renders
linked MCP Apps; **Protocol** shows MCP messages as sent; **Network** shows HTTP activity with
secret-like values masked in headers and bodies; and **Console** is for client/server diagnostics.
The monitoring sidebar is a quick view of the current connection and activity; use the detail tabs
when investigating a specific request.

The browser Apps test currently establishes rendering against synthetic approval data and checks
negative privacy/network controls. Its approve/deny attempts fail closed because this host does not
provide a verifiable app-origin signal or confirmation path. Do not treat HTML retrieval or rendering
as evidence that a human decision was successfully recorded.

### TUI

Run `mcp-inspector --tui` for terminal-only debugging when a browser is unavailable. It can connect
to stdio or HTTP targets and show the negotiated connection and MCP operations interactively. The
TUI is available in the pinned package, but its harness-specific behavior is not covered by the
current CI integration gate.

### CLI

Use `mcp-inspector --cli` for repeatable probes and CI-style checks without opening the web client.
The integration test above exercises modern and legacy initialization on both harness transports,
strict schema portability, Apps visibility and metadata, approval-resource retrieval, synthetic
`tools/call` cases, restricted-scope behavior, unauthenticated HTTP rejection, and a token-leak
canary. It does not establish a successful approval interaction.

For an Apps metadata-only probe, use `--method tools/list --app-info --advertise-apps`. For example:
`mcp-inspector --cli --server-url "$MCP_URL" --transport http --protocol-era modern --header "$CONTROL_PLANE_AUTH_HEADER" --stored-auth-only --method tools/list --app-info --advertise-apps`.
`--app-info` reports the linked resource metadata and does not invoke the tool. Inspector CLI does
not advertise MCP Apps by default because it cannot render them; the harness omits app-only tools
unless a client advertises the `io.modelcontextprotocol/ui` capability. Without
`--advertise-apps`, the metadata probe will not see those tools. `--strict` cannot be combined with
`--app-info`; the gate runs the schema check separately.

### `mcpdo` sessions (experimental)

`mcpdo` connects once and reuses a named connection through its local daemon. For a local stdio
session, a basic read-only sequence is:

1. `mcpdo connect --connection harness-local --transport stdio --era modern -- node packages/cli/dist/bin.js serve --stdio`
2. `mcpdo connections/show harness-local` and `mcpdo tools/list`
3. `mcpdo tools/call --tool-name list_runs --tool-args-json '{}'`
4. `mcpdo disconnect harness-local`, then `mcpdo daemon stop`

Use a disposable home directory for experiments and stop the daemon even after a failed session.
`mcpdo` is experimental and advisory; these commands are not a completed approval-flow test or a
blocking harness CI check. In particular, do not infer successful human confirmation from an
elicitation response alone.

## Protocol eras

The harness serves protocol revision **2026-07-28** as `modern` and **2025-11-25** as `legacy`.
Select `--protocol-era modern` or `--protocol-era legacy` in Inspector CLI, web, and TUI sessions;
`mcpdo` calls the option `--era`. Inspector CLI ad-hoc connections default to legacy, so choose an
era explicitly when comparing behavior. Modern and legacy use different initialization and
elicitation compatibility paths; the CLI gate verifies initialization and its listed operations in
both eras.

## Security and credentials

- Keep Inspector's per-launch API authentication enabled. The web launcher displays its API token
  and a tokenized URL; treat both as credentials. If setting the token explicitly, provide a fresh
  value through `MCP_INSPECTOR_API_TOKEN` for that launch. This protects Inspector's own API and is
  separate from the harness control-plane bearer token. Do not set `DANGEROUSLY_OMIT_AUTH` or any
  other `DANGEROUSLY_*` variable.
- Keep both Inspector and local `harness serve --http` bound to loopback. Inspector's web server
  defaults to `127.0.0.1`; do not set a public `HOST`, expose its port, or use an all-interface
  binding for this workflow.
- Inspector stores OAuth tokens, client secrets, and stdio environment secrets in the OS keychain
  when available. Without a keychain, secrets may be written in plain text to
  `~/.mcp-inspector/secrets.json`. Prefer the memory store for disposable sessions by setting
  `MCP_INSPECTOR_SECRET_STORE=memory`; to encrypt file-backed secrets, set
  `MCP_INSPECTOR_SECRET_KEY_FILE` to a separate, access-restricted key file. Do not store that key
  alongside `secrets.json`.
- Use only synthetic fixtures. Do not point Inspector at a deployment with
  `controlPlane.allowReveal: true` or at real user data. Inspector's Network tab masks secret-like
  values in headers and bodies, but this is not a substitute for keeping sensitive data out of
  requests and captures. The Protocol tab displays traffic as sent and can include those values.

For an OAuth-protected server, authorize it in the Inspector UI first. The CLI can then reuse
Inspector's stored credentials with `--use-stored-auth --stored-auth-only`; those credentials are
independent of the harness's encrypted OAuth store. The harness-side login and stored-auth workflow
is documented in [MCP server authorization](mcp-servers.md#authorization).

## Advisory MCP conformance lane

The separate GitHub Actions `conformance-advisory` job runs the pinned
`@modelcontextprotocol/conformance@0.2.0-alpha.12` runner against protocol `2026-07-28`. It measures
the harness MCP client role through `McpToolPort` (`tools_call`) and server role through the
control-plane (`server-stateless`, `tools-list`) over HTTP. The report records the runner and
protocol revisions, each measured result, required scenarios left `not_measured`, and
`not_scored` cases and reasons. Inspector interoperability results remain separate from this report;
neither is universal MCP certification.

This lane is advisory and does not feed the required `gates` job. Promote it to blocking only after
the owner reviews coverage and failures, approves the capability matrix, and deliberately updates
the pinned runner. Scenario failures are retained in the uploaded report and emitted as GitHub
Actions warnings; runner, setup, and report-validation errors still fail the job.

Verification decision: the Azure pipeline is retired; repository CI uses GitHub Actions. The
Inspector integration test maps to its `integration` job, and the conformance lane remains advisory.
