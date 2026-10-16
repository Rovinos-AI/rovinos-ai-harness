# MCP server configuration

The `servers` field is a list of MCP server configurations. Each server has a
stable `id` written as a `Code`; IDs must be unique. Server objects and
transports reject unknown fields.

## Common fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | `Code` | required | Stable server identifier. |
| `transport` | `stdio` or `http` object | required | How the client connects to the server. |
| `protocol` | `auto`, `2026-07-28`, or `2025-11-25` | `auto` | Protocol revision; `auto` negotiates a supported revision. |
| `apps` | boolean | `false` | Advertise the MCP Apps extension to this server. |
| `trust` | `internal` or `external` | `external` | Trust level used to gate trace propagation and annotations. |
| `propagateTrace` | boolean | `false` | Send trace context only to an `internal` server. |
| `toolAllowlist` | string array | omitted | Server-native tool names permitted for registration. |
| `toolPrefix` | `Code` | the server `id` | Prefix used when registering this server's tools. |
| `idempotentTools` | string array | omitted | Server-native tool names treated as idempotent. |
| `useAnnotations` | boolean | `false` | Whether to use server annotations; requires `trust: internal`. |
| `timeouts.connectMs` | positive integer | `10000` | Connection timeout in milliseconds. |
| `timeouts.callMs` | positive integer | `60000` | Tool-call timeout in milliseconds. |
| `maxResultBytes` | positive integer | `1048576` | Maximum accepted tool-result size in bytes. |

Tool names in `toolAllowlist` and `idempotentTools` are the names returned by
the server, before harness normalization. Names must be non-empty and unique
within each list. When `toolAllowlist` is set, every `idempotentTools` entry
must also be allowlisted. Effective tool prefixes must be unique across servers.

## Stdio transport

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | `stdio` | required | Selects the local process transport. |
| `command` | non-empty string | required | Executable to launch. |
| `args` | string array | `[]` | Arguments passed to the executable. |
| `env` | string or `SecretRef` values | omitted | Environment values for the process. Values under secret-looking keys must be `SecretRef`s. |
| `cwd` | non-empty string | omitted | Working directory for the process. |
| `inheritEnv` | boolean | `false` | Whether to inherit `PATH` from the parent environment. The SDK's other default-inherited values are cleared; configured `env` keys are then applied. |

## HTTP transport

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | `http` | required | Selects the HTTP transport. |
| `url` | URL string | required | HTTPS is required except for `localhost`, `127.0.0.1`, and `::1`; loopback accepts HTTP for local development. URLs must not contain usernames or passwords. |
| `headers` | `SecretRef` values | omitted | Request headers resolved from secret references. |

### Authorization

Remote HTTP servers can use OAuth authorization-code or client-credentials
authorization:

```yaml
servers:
  - id: remote-tools
    transport:
      kind: http
      url: https://mcp.example.test/mcp
      auth:
        kind: oauth
        grant: authorization_code
        clientId: harness-client
        scopes: [tools:read]
        redirectPort: 49152
```

`auth.clientSecret` is optional for authorization-code flows and is a secret
reference when configured. Client-credentials flows require `clientSecret`;
`clientId` may be configured or resolved by the authorization server's
registration flow. `clientIdMetadataUrl` can identify a Client ID Metadata
Document; the SDK uses it when supported and otherwise performs its supported
registration flow. OAuth secrets and tokens are stored in the encrypted
`<dataDir>/mcp-oauth.db` database using the configured key provider. Configure
`keys` before logging in so credentials can be encrypted with a persistent key.

Run `harness servers login <id>` to start an explicit authorization-code login.
The command prints the authorization URL and waits for the loopback callback on
`127.0.0.1`; it opens a browser only when `--open` is supplied. `harness servers
logout <id>` removes that server's stored OAuth credentials. Runtime calls do
not start an interactive authorization flow: an absent or unusable
authorization-code session fails with `mcp_auth_required`, and `harness doctor`
reports the `servers_authorized` check as failed. Client-credentials servers
obtain tokens non-interactively at connection time.

The SDK validates authorization-server metadata, issuer-bound credentials,
resource indicators, PKCE, and callback `iss` values where supplied. The
authorization server controls its own metadata and registration policy; check
its advertised capabilities and scopes before enabling a server.

Secret references use `env:NAME`, `file:/absolute/path`, or
`akv:vault/secret`. Header values are always references. Stdio environment
values may be literal strings unless the key looks secret-related, such as
`API_KEY`, `accessToken`, or `password`.

Connections resolve secret references only when opening the transport. Stdio
servers receive no parent environment values by default. If `inheritEnv` is
enabled, only the parent `PATH` and explicitly configured keys are available.
When `inheritEnv` is `false`, `command` must be an absolute path (or an executable
path runnable without `PATH`) because `PATH` is omitted from the child process.
The child stderr stream is never forwarded as text; only its byte count is
available to the safe logger.

The MCP SDK negotiates the protocol automatically unless `protocol` pins an
era. Tool discovery follows pagination, is capped at 1,000 tools, and caches
results according to the server-provided `ttlMs`. Modern list-change
subscriptions refresh the cached tools. Each page is validated against the
MCP `tools/list` result schema. On modern Streamable HTTP connections, tools
whose input schema declares `x-mcp-header` parameters are excluded; the
harness logs only the excluded count (`mcp_tools_excluded`), never tool names.
`harness doctor` reports a
`servers_reachable.<serverId>` result for each configured server; its `detail`
contains the configured server id.
The `servers_authorized` check covers configured OAuth servers separately from
reachability.

Registered MCP tool ids are normalized to the harness `Code` format, filtered
by `toolAllowlist`, and rejected when their schemas exceed the bounded JSON
Schema compiler limits or contain unsupported references. Server descriptions
are untrusted text: they may contain prompt injection, are sanitized before
being exposed as a model-visible tool description, and must pass through the
model-input PII boundary. They are descriptive only and never grant authority.
If two discovered tools normalize to the same id, startup fails with
`tool_id_collision`, including when both tools are from one server; the error
contains that normalized `Code` and both server ids (which can be identical).

## Examples

`examples/servers.yaml` contains a trusted internal stdio server with trace
propagation and an external HTTPS server without trace propagation. The data
and hostnames are synthetic; configure real endpoints and secret references
for your deployment.
