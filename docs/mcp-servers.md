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
the server, before harness normalization.

## Stdio transport

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | `stdio` | required | Selects the local process transport. |
| `command` | string | required | Executable to launch. |
| `args` | string array | `[]` | Arguments passed to the executable. |
| `env` | string or `SecretRef` values | omitted | Environment values for the process. Values under secret-looking keys must be `SecretRef`s. |
| `cwd` | string | omitted | Working directory for the process. |
| `inheritEnv` | boolean | `false` | Whether to inherit the parent environment. |

## HTTP transport

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | `http` | required | Selects the HTTP transport. |
| `url` | URL string | required | HTTPS is required except for `localhost`, `127.0.0.1`, and `::1`; loopback accepts HTTP for local development. |
| `headers` | `SecretRef` values | omitted | Request headers resolved from secret references. |

Secret references use `env:NAME`, `file:/absolute/path`, or
`akv:vault/secret`. Header values are always references. Stdio environment
values may be literal strings unless the key looks secret-related, such as
`API_KEY`, `accessToken`, or `password`.

## Examples

`examples/servers.yaml` contains a trusted internal stdio server with trace
propagation and an external HTTPS server without trace propagation. The data
and hostnames are synthetic; configure real endpoints and secret references
for your deployment.
