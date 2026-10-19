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

For an endpoint that implements MCP OAuth, first authorize that server using the Inspector UI so its
OAuth credentials are stored in the shared Inspector credential store. Then run the CLI with
`--use-stored-auth --stored-auth-only` and the same `--server-url`; the CLI reuses the stored
credential without prompting or opening a browser. This OAuth flow does not apply to the
control-plane's static bearer tokens.

Avoid placing token values directly in command history or checked-in configuration. Configure
`controlPlane.auth.tokens[].secret` with a `SecretRef` and expose its corresponding value only in the
local environment used to launch the Inspector.
