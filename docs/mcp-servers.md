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
| `apps` | boolean | `false` | Outbound MCP Apps are unsupported; setting `true` fails with `mcp_apps_unsupported`. |
| `trust` | `internal` or `external` | `external` | Trust level used to gate trace propagation and annotations. |
| `propagateTrace` | boolean | `false` | Send trace context only to an `internal` server. |
| `toolAllowlist` | string array | omitted | Server-native tool names permitted for registration. |
| `toolPrefix` | `Code` | the server `id` | Prefix used when registering this server's tools. |
| `idempotentTools` | string array | omitted | Server-native tool names treated as idempotent. |
| `useAnnotations` | boolean | `false` | Whether to use server annotations; requires `trust: internal`. |
| `timeouts.connectMs` | positive integer | `10000` | Connection timeout in milliseconds. |
| `timeouts.callMs` | positive integer | `60000` | Tool-call timeout in milliseconds. |
| `maxResultBytes` | positive integer | `1048576` | Maximum accepted tool-result size in bytes. |
| `maxArtifactBytes` | positive integer | `52428800` | Maximum combined decoded size of binary result artifacts for one call. |
| `binaryResults` | `block` or `allow` | `block` | Whether binary MCP result parts may be stored as run-workspace artifacts. |

MCP binary result parts are blocked by default (`mcp_binary_result_blocked`). To
enable them for a server, set `binaryResults: allow`. The combined decoded bytes
of all offloaded parts must fit `maxArtifactBytes`; the inline envelope after
artifact substitution must fit `maxResultBytes`. Allowed binary artifacts are
stored without tokenization but encrypted with the configured vault key in the
run workspace; retain old key versions while artifacts need to remain readable.
Pre-encryption artifacts return `artifact_legacy_unsupported`. See the details in
[the guarantees](guarantees.md#binary-mcp-artifacts).

Tool names in `toolAllowlist` and `idempotentTools` are the names returned by
the server, before harness normalization. Names must be non-empty and unique
within each list. When `toolAllowlist` is set, every `idempotentTools` entry
must also be allowlisted. Effective tool prefixes must be unique across servers.
The outbound client does not host MCP Apps. App-only tools are excluded from
tool discovery, and setting `apps: true` is rejected rather than advertising
unsupported capabilities.

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

Protected-resource discovery has a separate network policy under `auth.discovery`:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `profile` | `production`, `internal`, or `local-development` | `production` | Network profile used only for pre-initialize OAuth discovery. |
| `allowlist` | exact host/port entries | omitted | Optional restriction for `production` and `local-development`; required for `internal`. |

`production` permits public HTTPS destinations without an allowlist and rejects
loopback, private, link-local, multicast, unspecified, IPv4-mapped private, and
cloud-metadata addresses. An allowlist narrows this set. `internal` permits
private addresses only for explicitly allowlisted hosts and ports. Select
`local-development` explicitly to permit HTTP to loopback services; it does not
permit arbitrary private addresses. These profiles are independent of
`trust: internal`, which controls trace propagation and annotation use.

The discovery request follows at most five redirects manually, spends at most
20 seconds across the entire probe, and reads at most 2 MiB of metadata. Every
redirect is checked and DNS-pinned before its connection. DNS-rebinding
protection applies only to these discovery requests; the later MCP SDK HTTP
transport is not constrained by this discovery-specific socket pinning. Use an
enforced deployment network policy when broader egress control is required.

For a local HTTP MCP server, explicitly opt in:

```yaml
auth:
  kind: oauth
  grant: client_credentials
  clientSecret: env:MCP_OAUTH_SECRET
  discovery:
    profile: local-development
```

Run `harness servers login <id>` to start an explicit authorization-code login.
The command prints the authorization URL and waits for the loopback callback on
`127.0.0.1`; it opens a browser only when `--open` is supplied. `harness servers
logout <id>` removes that server's stored OAuth credentials. Runtime calls do
not start an interactive authorization flow: an absent or unusable
authorization-code session fails with `mcp_auth_required`, and `harness doctor`
reports the `servers_authorized` check as failed. Client-credentials servers
obtain tokens non-interactively at connection time.

Client-credentials authorization is enabled only when the protected-resource
metadata advertises the MCP extension under `extensions`, for example:

```json
{
  "extensions": {
    "io.modelcontextprotocol/oauth-client-credentials": {}
  }
}
```

This pre-initialize advertisement allows the first `initialize` request to
authenticate without enabling client credentials for servers that do not
support the extension.

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
era. Tool discovery follows pagination under the budgets below and caches only
complete results according to the server-provided `ttlMs`. Modern list-change
subscriptions refresh the cached tools. Each page is validated against the
MCP `tools/list` result schema. On modern Streamable HTTP connections, tools
whose input schema declares invalid `x-mcp-header` parameters are excluded; the
harness logs only the excluded count (`mcp_tools_excluded`), never tool names.
`harness doctor` reports a
`servers_reachable.<serverId>` result for each configured server; its `detail`
contains the configured server id.
The `servers_authorized` check covers configured OAuth servers separately from
reachability.

### Discovery budgets

These fixed defaults apply to each complete `tools/list` traversal, across all
pages and before invalid-header tools are excluded:

| Budget | Default | Enforcement layer |
| --- | --- | --- |
| Pages | 100 | MCP discovery loop; empty pages count and their continuation cursors are followed. |
| Observed tools | 1,000 | MCP discovery loop; rejected tools count too. |
| Each input or output schema | 1 MiB | Incremental decoded-JSON measurement, before header scanning. |
| Total decoded data | 8 MiB | Sum of compact JSON UTF-8 bytes for validated pages, including schemas, descriptions, metadata, and cursors. |
| Total duration | 30 seconds | One shared deadline for the traversal, never reset per page; the configured `callMs` can fail a page sooner. |
| Concurrent discoveries | 4 per process | Excess discoveries wait in a cancellable FIFO queue. Each 30-second deadline starts after admission, not while waiting. Calls on the same connection share an in-flight refresh. |

Repeated cursors fail with `mcp_list_tools_failed`. Exceeding pages, observed
tools, schema bytes, or total decoded bytes fails with
`mcp_discovery_page_limit`, `mcp_too_many_tools`,
`mcp_discovery_schema_limit`, or `mcp_discovery_data_limit`, respectively.
Deadline expiry and cancellation use
`mcp_discovery_timeout` and `mcp_discovery_cancelled`.
These errors contain only closed codes, never server content. Discovery fails
for that server; partial results are not returned, registered, or cached.
If a list-change notification invalidates an in-flight traversal, that refresh
fails with `mcp_list_tools_failed` rather than caching the older snapshot; the
next discovery call starts fresh.

Cancellation stays inside `@rovinos/mcp`: an optional `AbortSignal` on
`McpConnection.listTools` cancels a shared refresh, including its outstanding
SDK request. Closing the connection also cancels discovery. No `@rovinos/sdk`
public types are changed. Connection establishment has its own existing timeout;
the discovery deadline begins when traversal starts.
Queued discoveries do not consume a running slot or deadline budget. Cancelling
a queued discovery removes it without contacting the server; later waiters keep
their FIFO order.
Legacy peers lack per-request stream cancellation, so cancellation or deadline
expiry closes that connection to stop its outstanding body read; subsequent
calls reconnect.

These are **decoded-data limits, not wire-byte limits**. The SDK may already
have buffered and parsed the HTTP response (or decoded a stdio message) before
the discovery layer measures it. Measurement bounds subsequent traversal and
header-scanning work; it does not cap SDK buffering, parsing, or heap usage.
The deadline aborts outstanding HTTP body reads, but JavaScript timers and
cancellation cannot preempt synchronous SDK parsing. A wire-byte guarantee
requires transport-layer limits on streamed HTTP bodies (including SSE),
decompression, and stdio framing before buffering and JSON decoding.

Registered MCP tool ids use the harness `Code` format and are filtered by
`toolAllowlist`. Native tool names may use any casing, but normalization must
not replace or collapse any characters. CamelCase names such as `getWeather`
remain available with a lowercased tool id; names with a trailing space,
non-ASCII characters, punctuation that normalization replaces, or repeated
underscores are rejected with `tool_name_invalid`. Servers relying on names
that require those replacements or collapses must rename their tools; otherwise
the tools will no longer be available. Case-only duplicate names normalize to
the same id and fail startup with `tool_id_collision`.
Schemas exceeding the bounded JSON Schema compiler limits or containing
unsupported references are also rejected. Server descriptions are untrusted
text: they may contain prompt injection, are sanitized before being exposed as
a model-visible tool description, and must pass through the model-input PII
boundary. They are descriptive only and never grant authority.
If two discovered tools normalize to the same id, startup fails with
`tool_id_collision`, including when both tools are from one server; the error
contains that normalized `Code` and both server ids (which can be identical).

## Catalog versions and run behavior

Each run pins a fingerprint of the complete MCP catalog it was shown and a
fingerprint for each exposed tool. These fingerprints include normalized
aliases, descriptions, schemas, server routes, and execution metadata. New runs
refresh discovery using each connection's `tools/list` TTL and list-change
notifications before exposing tools. An already-running model request keeps
its pinned specifications. Before dispatch, the harness refreshes discovery
and compares only the called tool with its pinned fingerprint. A removed or
changed tool fails with `mcp_catalog_changed`; unrelated catalog changes do
not block unchanged tools or expose new tools to the active run. A failed
refresh rejects dispatch rather than treating an old catalog as freshly
validated.

The fingerprints are stored on the run's `run_created` event. On resume, only
tools matching the per-tool baseline are exposed; a pending or approved call
for a removed or changed tool fails closed at dispatch. New and changed tools
do not inherit permissions or approvals. Legacy runs without per-tool
fingerprints have no saved baseline to compare against, so they resume against
the catalog discovered at resume time; normal policy and approval checks still
apply. A run that has only the older whole-catalog fingerprint uses a
conservative complete-fingerprint match because it cannot identify which
individual tool changed.

This check compares local discovery snapshots, not a remote, version-bound
execution guarantee. A server may change its behavior after `tools/list`, may
not send a change notification, or may not enforce its advertised schema. The
harness detects changes only when discovery observes them, and MCP does not
provide an atomic operation that binds a tool call to the previously listed
schema.

## Examples

`examples/servers.yaml` contains a trusted internal stdio server with trace
propagation and an external HTTPS server without trace propagation. The data
and hostnames are synthetic; configure real endpoints and secret references
for your deployment.
