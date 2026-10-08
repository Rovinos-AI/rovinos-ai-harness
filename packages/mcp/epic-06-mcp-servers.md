# Epic #6: MCP servers (client and tool bridge)

**Goal:** connect the harness to MCP servers as tool providers, with safe, per-server trace propagation, strict tool registration, and typed error mapping. Read `docs/engineering/CONVENTIONS.md` first.
**Tasks:** 6.1 to 6.8, all size S.

Shared design for this epic:

- Package `packages/mcp` wraps the official TypeScript SDK v2 client (`@modelcontextprotocol/client`, CONVENTIONS section 10) and exposes `McpToolPort implements ToolPort` (port from 2.4). It speaks MCP 2026-07-28 (stateless requests, per-request `_meta` capabilities, `server/discover`) and falls back to 2025-11-25 peers through the SDK's `versionNegotiation: { mode: "auto" }`. Deprecated features (Sampling, Roots, Logging) are never declared or used.
- **Servers are untrusted by default.** Tool names, descriptions, annotations, error text, and result content all come from outside. Names are normalized and registered; descriptions are length-capped and sanitized; error text never enters codes, spans, or logs; annotations are hints used only when explicitly enabled for a trusted server.
- **Trace context goes only to trusted servers**, only in `params._meta`, never `baggage` (MCP 2026-07-28 documents the `_meta` keys `traceparent`, `tracestate`, and `baggage` from SEP-414; the harness sends only the first two).
- Tool results are content: they flow through the PII boundary (13.7) and offloading (15.4) after this layer.

---

## 6.1 Zod `servers` config schema

**Parent:** #6 MCP servers
**Task Description:** Define and validate the MCP server configuration with trust and propagation rules.
**Expected Inputs:** `servers:` section of the config file.
**Expected Output:** `packages/schemas/src/config/servers.ts` (`ServerConfig`), `examples/servers.yaml`, docs `docs/mcp-servers.md`.
**Dependencies:** `zod`.
**Items it depends on:** 20.1, 20.3.
**Implementation guidance:**

1. `ServerConfig = { id: Code, transport: Stdio | Http, protocol: "auto" | "2026-07-28" | "2025-11-25" (default "auto"), apps: boolean (default false; advertise the MCP Apps extension to this server), trust: "internal" | "external" (default "external"), propagateTrace: boolean (default false), toolAllowlist?: string[], toolPrefix?: Code (default = id), idempotentTools?: string[], useAnnotations: boolean (default false), timeouts: { connectMs: int (default 10000), callMs: int (default 60000) }, maxResultBytes: int (default 1048576) }`.
2. `Stdio = { kind: "stdio", command: string, args: string[] (default []), env?: Record<string, string | SecretRef>, cwd?: string, inheritEnv: boolean (default false) }`. `Http = { kind: "http", url: string (https required unless host is localhost/127.0.0.1/::1), headers?: Record<string, SecretRef> }`.
3. Refinements: `propagateTrace: true` requires `trust: "internal"` (`propagate_requires_internal`); `useAnnotations: true` requires `trust: "internal"`; header values and env values whose keys match the secret-name pattern from 20.3 must be `SecretRef`; unique `id`s across servers; `toolPrefix` must be a Code.
4. Tool names in `toolAllowlist`/`idempotentTools` are server-native names (not normalized ids).
5. Document each field and show a trusted internal and an external example.
**Tests to write:** valid configs; each refinement rejection; HTTPS rule table; unique ids; defaults applied; example file validates.
**Acceptance Criteria:**

- [ ] Trace propagation cannot be enabled for external servers.
- [ ] Secret-looking headers and env keys must be `SecretRef`.
- [ ] Example config validates in CI.

---

## 6.2 Stdio and HTTP connections via the MCP SDK, listing tools

**Parent:** #6 MCP servers
**Task Description:** Manage connections to all configured servers with timeouts, lazy reconnect, and tool discovery.
**Expected Inputs:** Validated `ServerConfig[]`, secret resolver.
**Expected Output:** `packages/mcp/src/{connection.ts,pool.ts,transports.ts}`, doctor check `servers_reachable`.
**Dependencies:** `@modelcontextprotocol/client` (v2: `Client`, `StdioClientTransport` from `@modelcontextprotocol/client/stdio`, the Streamable HTTP client transport, `versionNegotiation`, `getProtocolEra()`; verify names against the pinned version).
**Items it depends on:** 6.1, 20.3, 20.4.
**Implementation guidance:**

1. `McpConnection(config, deps)`: `connect()` creates the SDK `Client` and transport. Stdio: spawn `command` with `args`; environment is **not** inherited unless `inheritEnv`; if inherited, pass only `PATH` plus configured keys; resolve `SecretRef`s through the resolver at connect time. HTTP: build headers from resolved secrets.
2. Connect with `timeouts.connectMs` (`AbortSignal.timeout`); failures map to `mcp_connect_failed` or `mcp_connect_timeout`.
3. `listTools()` follows pagination cursors until exhausted (cap 1,000 tools, `mcp_too_many_tools`).
4. State machine: `connecting -> ready -> unavailable`; on transport close mark `unavailable`; the next `callTool` triggers a lazy reconnect (max 3 attempts, backoff 250 ms, 1 s, 4 s via injected sleep).
5. Capture a stdio child's stderr and forward only `bytes` counts to the logger (`mcp_stderr` with an integer), never text.
6. `McpPool` holds all connections, connects eagerly at startup in parallel, tolerates individual failures (marks unavailable, logs code), and shuts down all connections on `close()`.
7. `servers_reachable` doctor check reports per-server state.
8. Protocol: use `versionNegotiation: { mode: "auto" }` for `protocol: "auto"` (probe `server/discover`, fall back to the 2025 handshake), `{ pin: "2026-07-28" }` for modern-only servers, and the legacy mode only when pinned to 2025-11-25. Record the negotiated era per server (`getProtocolEra()`). On 2026-07-28 there are no protocol sessions: client capabilities travel in each request's `_meta`; cache `tools/list` per the result's `ttlMs` and `cacheScope` and refresh on list-changed notifications received through `subscriptions/listen`.
9. A broken Streamable HTTP response stream loses the in-flight request (2026-07-28 removed resumability). Re-issue it only for idempotent tools; otherwise return `mcp_connection_lost` and let the resume policy (2.5) decide.
**Tests to write:** unit tests using the SDK's in-memory transport pair: connect, list tools with pagination, timeout, reconnect logic with fake sleep, shutdown; env inheritance table test (no leakage of parent env keys); stderr bytes counted not logged.
**Acceptance Criteria:**

- [ ] Parent process environment is not leaked to stdio servers by default.
- [ ] A dead server becomes `unavailable` and reconnects lazily.
- [ ] No server text reaches logs.

---

## 6.3 Tool registry: normalization, allowlist, and safe descriptions

**Parent:** #6 MCP servers
**Task Description:** Convert server tools into registered, safe `ToolSpec`s and metadata for the run loop.
**Expected Inputs:** Server tool lists, `ServerConfig`.
**Expected Output:** `packages/mcp/src/registry.ts` (`ToolRegistry`, `normalizeToolId`), `ToolPort.describe` support, rejected-tool report.
**Dependencies:** none.
**Items it depends on:** 6.2, 14.2.
**Implementation guidance:**

1. `normalizeToolId(prefix, nativeName)`: lower-case, replace any character outside `[a-z0-9_.-]` with `_`, collapse repeats, join as `<prefix>.<name>`, truncate to 64 characters keeping a hash suffix if truncated (`...-<6 hex>`). The result must match `Code`; otherwise reject with reason `tool_name_invalid`.
2. Registry build: apply `toolAllowlist` (when set, only listed native names), detect collisions across servers (`tool_id_collision` fails startup with both server ids), and cap input schema size (64 KiB, else reject `tool_schema_too_large`). Tool `inputSchema`/`outputSchema` may use any JSON Schema 2020-12 keyword (MCP 2026-07-28); compile them with `compileJsonSchema` (1.12), which bounds `$ref` resolution and rejects remote references (`tool_schema_unsupported`). Keep tools in the server's (deterministic) order.
3. `ToolSpec.description`: take the server description, strip control characters, collapse whitespace, truncate to 1024 characters; treat as untrusted text (document that it can contain prompt injection and is therefore also passed through the PII boundary and shown to the model as a tool description only).
4. `describe(toolId)`: `{ idempotent, timeoutMs }`; `idempotent` is true only if the native name is in `idempotentTools`, or (trusted server with `useAnnotations`) the MCP annotation `idempotentHint`/`readOnlyHint` is true (verify field names). Default false.
5. Telemetry safety: only registered ids are ever used as `toolId`; any event or span that must refer to an unknown tool uses the constant `unregistered_tool`.
6. Expose `rejected(): { serverId, nativeName?, reason: Code }[]` for 6.6.
**Tests to write:** normalization table (uppercase, spaces, unicode, long names with hash suffix, collisions); allowlist; schema size cap; description sanitization; idempotency rules including annotation gating; `unregistered_tool` constant used for unknown calls.
**Acceptance Criteria:**

- [ ] Every tool id in events is registered and matches `Code`.
- [ ] Collisions fail startup with a clear code.
- [ ] Annotations never make a tool idempotent on external servers.

---

## 6.4 Trace context injection for trusted servers only

**Parent:** #6 MCP servers
**Task Description:** Propagate `traceparent`/`tracestate` through request `_meta` to servers explicitly marked trusted, never baggage.
**Expected Inputs:** Active span context, `ServerConfig`.
**Expected Output:** `packages/mcp/src/trace-injection.ts` (`buildRequestMeta`), integration in the call path, docs `docs/telemetry/mcp-propagation.md`.
**Dependencies:** `@opentelemetry/api`.
**Items it depends on:** 6.3, 4.1.
**Implementation guidance:**

1. `buildRequestMeta({ server, spanContext, existingMeta }): Record<string, unknown> | undefined`: when `server.propagateTrace` and `server.trust === "internal"`, return `{ ...existingMeta, traceparent: "00-<traceId>-<spanId>-<flags>", tracestate?: <string> }` using the **MCP call span** context; otherwise return `existingMeta` unchanged. Never add `baggage`; actively delete any `baggage` key present in `existingMeta`.
2. Preserve existing `_meta` keys (for example `progressToken`) and never overwrite them; if `traceparent` already exists, replace only for trusted servers.
3. Pass `_meta` in the SDK call (verify `callTool` params shape); for HTTP transports ensure no instrumentation injects `traceparent` or `baggage` headers (assert in tests by inspecting captured requests).
4. Add a debug-only assertion that `tracestate` length is at most 512 characters, dropping it otherwise.
5. Document that trace ids are correlation identifiers and therefore only shared with trusted servers.
**Tests to write:** trusted server receives well-formed traceparent equal to the call span; external server receives no trace keys; existing `_meta` preserved; baggage stripped; invalid span context omitted; HTTP header capture test shows no injected headers.
**Acceptance Criteria:**

- [ ] External servers never receive trace context.
- [ ] `baggage` is never sent.
- [ ] Existing request metadata is preserved.

---

## 6.5 Tool execution and result/error mapping

**Parent:** #6 MCP servers
**Task Description:** Implement `McpToolPort.execute` with typed outcomes and code-only error mapping.
**Expected Inputs:** Tool calls from the run loop, registry, pool.
**Expected Output:** `packages/mcp/src/tool-port.ts` (`McpToolPort`), `harness.mcp_call` span definition (via `defineSemconvSpan` for `mcp.method.name`), error mapping table.
**Dependencies:** none.
**Items it depends on:** 6.3, 6.4, 2.4, 4.7.
**Implementation guidance:**

1. `execute(call, ctx)`: resolve `toolId` to `(serverId, nativeName)`; get the connection (reconnect lazily); start the `harness.mcp_call` span (attributes: `mcp.method.name = "tools/call"`, `harness.mcp.server_id` (code), `harness.tool.id` (code), `harness.outcome` (enum)); call with `AbortSignal.any([ctx.signal, AbortSignal.timeout(callMs)])`.
2. Result mapping: MCP `isError: true` -> `{ outcome: "error", errorCode: "tool_reported_error", result: <content> }`; success -> `{ outcome: "ok", result }`. `result` is a JSON value `{ content: Block[], structured?: JsonValue }`; text blocks kept, image/audio/resource blocks reduced to `{ type, mimeType, bytes }` with data stored only if small (otherwise flagged `binary: true` for offloading and excluded from the transcript).
3. Protocol errors mapped by JSON-RPC code: `-32602 -> mcp_invalid_params`, `-32601 -> mcp_method_not_found`, `-32603 -> mcp_internal_error`, others -> `mcp_error`; timeouts -> `mcp_timeout`; connection loss -> `mcp_connection_lost`. **Error message text is never copied** into codes, spans, or logs.
4. Enforce `maxResultBytes` on the serialized result (`result_too_large`, outcome `error`).
5. Validate tool arguments against the tool's `inputSchema` (via `compileJsonSchema`, 1.12) before sending; failures produce `errorCode: "args_invalid"` without calling the server. Tool parameters mapped to HTTP headers by the server's `x-mcp-header` declarations carry the same values as the arguments (tokens stay tokens unless detokenized by the allowlist, 13.5); never add trace context or secrets through them.
6. Results: treat a missing `resultType` from older servers as `complete`. An `input_required` result is not a failure: hand it to the human-input flow (epic 25) instead of mapping it to an error. Map the renumbered 2026-07-28 error codes (`-32020` header mismatch, `-32021` missing client capability, `-32022` unsupported protocol version) to `mcp_header_mismatch`, `mcp_capability_missing`, and `mcp_protocol_unsupported`.
7. Never retry non-idempotent tools inside this layer.
**Tests to write:** in-memory server: success, `isError`, JSON-RPC errors, timeout, abort, large result, binary block, invalid args pre-validation; assert span attributes only use registered fields; assert no server error text appears in events, spans, or log captures (canary in error text).
**Acceptance Criteria:**

- [ ] All failure modes yield typed outcomes with codes only.
- [ ] Oversized or binary results never enter the transcript raw.
- [ ] Argument validation happens before network I/O.

---

## 6.6 `harness servers check`

**Parent:** #6 MCP servers
**Task Description:** Diagnostic command showing connectivity, registered tools, rejected tools, and propagation behavior per server.
**Expected Inputs:** Config.
**Expected Output:** `packages/cli/src/commands/servers.ts`, docs in `docs/cli.md`.
**Dependencies:** none.
**Items it depends on:** 6.5, 20.2.
**Implementation guidance:**

1. `harness servers check [--server <id>] [--json]`: connect, list tools, build the registry, then print per server: id, transport kind, negotiated protocol era and version, whether the server supports the MCP Apps extension, trust, connect latency (ms), tool count, registered tool ids, rejected tools with reason codes, and `tracePropagation: "yes" | "no"` plus the reason (`external`, `disabled`, `enabled`).
2. Never call any tool and never print tool descriptions or server-provided text.
3. Exit code 0 if all selected servers are reachable, 1 otherwise; `--json` prints a single document.
4. Show a clear warning row when a trusted server has `propagateTrace: false` or an external server has `useAnnotations` set (the latter cannot be, by schema; test the schema path).
**Tests to write:** CLI tests with in-memory servers: healthy, unreachable, rejected tools listed with reasons, JSON shape, exit codes; assertion that no descriptions are printed.
**Acceptance Criteria:**

- [ ] The command never invokes tools.
- [ ] Output makes propagation behavior explicit.
- [ ] Failures are reflected in the exit code.

---

## 6.7 Sample server fixture and compose integration test

**Parent:** #6 MCP servers
**Task Description:** Provide a real MCP server container exercising propagation, errors, and idempotency semantics end to end.
**Expected Inputs:** SDK server API.
**Expected Output:** `test/fixtures/sample-mcp-server/` (TypeScript source, Dockerfile), `sample-mcp-server` service in `docker-compose.test.yml`, `test/mcp-servers.int.test.ts`.
**Dependencies:** `@modelcontextprotocol/server` and `@modelcontextprotocol/node` (v2, `createMcpHandler` serving both protocol eras), `@opentelemetry/api`.
**Items it depends on:** 6.5, 6.6, 1.8.
**Implementation guidance:**

1. Server (streamable HTTP on port 3333, internal network only) with tools: `echo` (returns its input), `send_message` (increments a persisted counter file, non-idempotent), `slow` (sleeps N ms honoring cancellation), `fail` (returns `isError: true` with text containing a canary), `big` (returns a 2 MiB text), `trace_probe` (extracts `traceparent` from request `_meta` using OTel propagation, starts a child span, and returns `{ receivedTraceparent, hasBaggage, childParentSpanId }`).
2. The server exports its own spans to an in-memory list readable via a `get_spans` tool (test only) so the test can verify the parent linkage.
3. Integration tests: trusted configuration -> `trace_probe` shows a traceparent equal to the harness call span and the server span's parent id matches; external configuration -> `receivedTraceparent` is null; `hasBaggage` is always false; `fail` error text does not appear in events, spans, or logs (canary); `big` triggers `result_too_large`; `slow` cancels on abort; `send_message` counter is exactly 1 after a crash-injection style resume scenario (reuse 2.11 with this server).
4. Add the fixture to the canary suite (8.5) as a source of raw values in tool outputs.
**Tests to write:** the integration tests above in the Azure `integration` stage.
**Acceptance Criteria:**

- [ ] Trace linkage verified against a real server.
- [ ] External servers receive no trace context.
- [ ] Non-idempotent tool executes exactly once across crash/resume.

---

## 6.8 OAuth authorization for remote MCP servers

**Parent:** #6 MCP servers
**Task Description:** Support MCP authorization (OAuth 2.1) for HTTP servers through the SDK's client auth support, with encrypted token storage and an explicit login command.
**Expected Inputs:** `ServerConfig` with `transport.kind: "http"` and an `auth` block; a human for interactive login.
**Expected Output:** `auth` field in `packages/schemas/src/config/servers.ts`, `packages/mcp/src/oauth/{provider.ts,token-store.ts}`, CLI `harness servers login <id>` and `harness servers logout <id>`, doctor check `servers_authorized`, docs `docs/mcp-servers.md` section "Authorization".
**Dependencies:** `@modelcontextprotocol/client` (v2) OAuth support (`OAuthClientProvider`, `transport.finishAuth(params)` with `iss` validation, issuer-bound credentials, `AuthProvider` for static bearer tokens; verify names), `@harness/crypto`.
**Items it depends on:** 6.2, 12.2, 12.3, 20.2.
**Implementation guidance:**

1. Config: `Http.auth?: { kind: "oauth", grant: "authorization_code" | "client_credentials", clientId?: string, clientSecret?: SecretRef, scopes?: string[], redirectPort?: int (loopback, default random) }`. `client_credentials` requires `clientSecret`.
2. Implement the SDK's `OAuthClientProvider` so discovery (protected resource metadata, authorization server metadata), client registration, PKCE, resource indicators, and refresh all come from the SDK. Registration follows MCP 2026-07-28: prefer Client ID Metadata Documents (config `clientIdMetadataUrl`); fall back to Dynamic Client Registration (deprecated) only when the authorization server lacks support, sending an appropriate `application_type`. Validate `iss` in authorization responses (RFC 9207) by passing the callback parameters to `transport.finishAuth(params)`. Persist credentials keyed by issuer and never reuse them with a different authorization server (re-register when it changes). `client_credentials` uses the official `io.modelcontextprotocol/oauth-client-credentials` extension when the server advertises it.
3. Token store: a dedicated SQLite file `<dataDir>/mcp-oauth.db` holding access and refresh tokens and client registrations per server id, encrypted with AES-GCM via `@harness/crypto` using a key from the `KeyProvider` (AAD = server id). Tokens never appear in logs, spans, errors, or `servers check` output.
4. `harness servers login <id>`: authorization code flow with a loopback redirect (`127.0.0.1`, RFC 8252 style). Print the authorization URL; open a browser only with `--open`. `logout` deletes the stored tokens.
5. At run time an expired session refreshes silently. If interactive authorization is needed, the call fails with `mcp_auth_required`, the server is marked `unavailable`, and `harness doctor` reports `servers_authorized: fail`. Runs never start interactive client authorization themselves; URL-mode elicitation is a different mechanism (epic 25) and must not be used for authorizing the harness to the server.
6. `client_credentials` servers authenticate non-interactively at connect time.
7. Update `layers.json`: `mcp` may import `crypto`.
**Tests to write:** mock authorization server (discovery, registration, code exchange with PKCE, refresh, client credentials); token store encryption (no plaintext token in DB bytes, wrong AAD fails); login command with a fake browser hitting the loopback redirect; expired token refresh; `mcp_auth_required` path; no token in any log or output (canary).
**Acceptance Criteria:**

- [ ] Remote servers that require MCP authorization connect after `harness servers login`.
- [ ] Tokens are encrypted at rest and never printed.
- [ ] Runs fail clearly instead of starting interactive authorization.
