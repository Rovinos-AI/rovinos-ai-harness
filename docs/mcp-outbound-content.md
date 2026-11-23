# Governed outbound MCP resources and prompts (6.18)

This document records the design and implementation status for outbound MCP
resource and prompt content. Resource discovery and reads are implemented in
task 6.21; prompt listing and retrieval are implemented in task 6.22 under the
approved public contract below. Resource blocks embedded in `tools/call`
results continue through the existing tool-result handling path. The inventory
was checked against the pinned MCP TypeScript SDK v2.4.0 declarations and
protocol baselines in
[engineering conventions](engineering/CONVENTIONS.md#10-external-protocol-and-sdk-baseline).

## Capability matrix

“Implemented” describes current harness behavior, not merely an SDK method.
Protocol versions are the modern 2026-07-28 revision and the legacy 2025-11-25
revision negotiated by the existing SDK client and server transports.

| Capability | Outbound client, modern | Outbound client, legacy | Inbound control-plane server, modern | Inbound control-plane server, legacy |
| --- | --- | --- | --- | --- |
| Tools list/call | Implemented | Implemented | Implemented | Implemented |
| Resources list/read | Implemented; explicit per-server grants | Implemented; explicit per-server grants | Implemented; run resources are permission-checked | Implemented; run resources are permission-checked |
| Resource subscriptions/updates | Implemented when the server declares support | Implemented when the server declares support | Implemented for subscribed run-resource updates | Implemented for subscribed run-resource updates |
| Prompts list/get | Implemented with explicit grants and per-run selections | Implemented with explicit grants and per-run selections | Unsupported | Unsupported |
| Completions | Unsupported | Unsupported | Unsupported | Unsupported |

The outbound client uses tool discovery and configured elicitation capabilities.
It does not declare client `resources` or `prompts` capabilities. Resource
operations require explicit grants and server resource capabilities; prompt
operations require an exact grant and server prompt capability. Prompt methods
are invoked only for operator-selected prompts. The control-plane server
registers resources with per-request authorization and supports resource
subscriptions; it does not register prompts. Although SDK v2.4.0 exposes
`listResources`, `readResource`, `listPrompts`, `getPrompt`, and `complete`,
their existence does not make those features implemented. Completions have no
identified harness consumer, so they are unsupported and not planned. No
capability in this matrix is experimental. Sampling, Roots, Logging, and
deprecated HTTP+SSE remain out of scope.

The client resource rows refer to standalone discovery/read APIs. Resource
blocks embedded in `tools/call` results already pass through the existing
result-normalization and content-processing path.

## Proposed access and data contract

These are the governing decisions for the implemented resource and prompt APIs.

- **Select one server first.** A resource or prompt request must be routed only
  through the configured server connection selected by code. A URI supplied by
  a resource, prompt, model, or user must never select a server, change its
  transport, or cause a direct network request.
- **Default deny.** Discovery is metadata, not permission. Require explicit
  per-server grants for resource URIs (including template expansion) and prompt
  names before exposing or retrieving them. Keep these grants separate from
  `toolAllowlist`; selecting a server or marking it `trust: internal` is not a
  content-access grant. Do not select all discovered resources or prompts by
  default.
- **Use the configured connection's authentication only.** HTTP OAuth
  credentials remain issuer-bound and scoped to their configured server. Never
  forward credentials to a URI found in returned content, across servers, or
  into a model request. The transport URL and secret-resolution policy remain
  authoritative.
- **Do not dereference returned links.** Resource URIs are opaque server-scoped
  identifiers passed to `resources/read` on that same connection. Do not fetch
  embedded URLs, image links, or URI contents outside MCP. Reject a URI that
  does not match the grant before issuing a request.
- **Bound every traversal and response.** Reuse the current finite list
  traversal limits (100 pages, 1,000 entries, 8 MiB decoded discovery data,
  30-second shared deadline, and four concurrent discoveries). Reuse the
  configured per-server `maxResultBytes` (currently 1 MiB) as the maximum
  decoded response envelope for one resource read or prompt result. Add a
  proposed 4 MiB cumulative decoded-content limit per model request across all
  selected resources and prompts, and allow at most four concurrent content
  reads per process in a cancellable FIFO queue. Also require the resulting
  tokenized context to fit the model's existing context budget. Enforce limits
  incrementally where the SDK permits and fail closed without truncation or
  partial model input if any limit is exceeded. These decoded-data limits do
  not bound bytes already buffered or parsed by the SDK; transport framing,
  streamed body, and decompression limits must be addressed before claiming a
  wire- or memory-size guarantee.

  **SDK buffering finding (6.23):** The pinned TypeScript SDK v2.4.0
  `StreamableHTTPClientTransport` calls `response.json()` for JSON-RPC HTTP
  responses before delivering the parsed message to `Client.readResource()`.
  Consequently, a decoded-size check after `readResource()` returns is too late
  to bound HTTP response buffering or decompression. The transport must enforce
  those limits while consuming the response body.
- **Stdio framing finding (6.23):** SDK v2.4.0 does not buffer a newline-
  delimited frame without a limit. Its `ReadBuffer` rejects an append that
  would exceed `maxBufferSize` before concatenating the chunk, then the stdio
  transport reports the error and closes. The default is 10 MiB; the harness
  configures it to the server's `maxResultBytes` so the frame cap matches the
  response envelope bound.
- **Redirects stay at the transport boundary.** Reading an MCP resource or
  prompt must not follow a URI as an HTTP URL. For the configured HTTP MCP
  endpoint, deny redirects by default; any future redirect support must be
  bounded and reapply the existing destination and authentication policy at
  each hop. OAuth metadata discovery's redirect policy does not constrain the
  later MCP transport.
- **Honor cancellation.** Pass the caller's `AbortSignal` through discovery,
  read/get, and response consumption, with one shared deadline per traversal
  and the configured call timeout per request. Preserve the existing legacy
  behavior of closing the connection when needed to stop an outstanding
  buffered response. Cancellation must not cache or expose partial content.
- **Keep content untrusted.** Resource contents and prompt descriptions,
  templates, arguments, and messages are server-controlled input. Validate
  structure and size, pass text through the existing model-input PII boundary,
  and preserve tokenization in context and snapshots. Keep retrieved content
  separate from system/developer policy; it cannot change tool permissions,
  approval requirements, server grants, or policy. Prompt retrieval is not
  equivalent to trusting or executing a prompt.
- **Preserve provenance without leaking content.** Keep server id and an opaque
  grant identifier (not a raw URI) or a validated prompt name attached as
  structured provenance at the model-input boundary. Treat URI values and
  prompt arguments as content at the PII boundary. Do not place raw content,
  arguments, URI values, or server-provided error text in events, logs, spans,
  telemetry, or diagnostics. Do not persist a separate content cache. Any
  content retained in a run context or snapshot remains tokenized and follows
  existing retention rules.
- **Human input is not authority.** A resource read that requires elicitation
  may use the existing configured elicitation modes and human-input broker only
  when the request is bound to the exact in-flight server, method, URI, and
  arguments. Validate each round, decline secret-seeking forms, never open
  elicitation URLs, and retry only with the exact request state and tokenized
  answers. Do not add prompt-get elicitation until a concrete workflow and
  protocol/API behavior are approved; the current client handles tool-call
  elicitation, not prompt retrieval.

## Outbound prompt retrieval (6.22)

The public contract was reviewed before implementation. Server configuration
uses `promptGrants`, an exact list of unique prompt names allowed for that
server. A run can select at most 16 prompts through the SDK's
`startRun({ promptSelections })` option; each selection contains the server id,
exact prompt name, and optional string arguments. Selection is default-deny
and grants are independent of tool allowlists and server trust.

Argument records are limited to 32 entries, 128 UTF-8 bytes per name, 8 KiB
per value, and 32 KiB in total. Arguments must match the selected prompt's
advertised arguments, include all advertised required values, and contain no
undeclared values. Listing follows at most 100 pages and 1,000 prompts, with an
8 MiB decoded catalog limit and a 30-second shared deadline. One prompt result
is limited to 1 MiB and all selected results together to 4 MiB. Servers with
nonempty `promptGrants` must keep `maxResultBytes` at or below 1 MiB so the SDK
stdio frame limit is consistent. These are decoded-data limits; they do not
claim to cap HTTP response buffering before parsing.

Retrieved descriptions and messages are serialized, passed through the
model-input PII tokenization boundary, and stored only in the existing
tokenized `run_input` content. The transcript frames each item as untrusted
data, with server id and prompt name provenance, and explicitly denies it
authority over policy, tools, approvals, or user input. Prompt content is
retrieved for each run and is not cached; MCP does not provide an atomic
version guarantee between listing and retrieval. The client does not advertise
prompt support in its own initialization capabilities. Failures use the closed
codes `mcp_prompt_not_granted`, `mcp_prompt_unavailable`,
`mcp_prompt_arguments_invalid`, `mcp_prompt_result_too_large`, and
`mcp_prompt_failed`. Completion remains unsupported.

The resource API has change notifications but no atomic read/version guarantee.
When an allowed resource changes, invalidate discovery/content caches and
re-read before a later model request. Do not claim that a notification prevents
the server changing content after a read. Prompts must likewise be retrieved
for the active request rather than reused from an unversioned cross-run cache.

## Threat-focused test matrix

| Case | Stimulus | Required result |
| --- | --- | --- |
| Unauthorized URI | Read a URI without a grant, a template outside its grant, or an allowed URI through another server id | Deny before network I/O; no fallback to another server |
| Prompt injection | Resource or prompt text asks to ignore policy, reveal secrets, or invoke a tool | Content is marked untrusted and tokenized; policy and approval decisions are unchanged |
| Changed resource | Update notification arrives between discovery and the next model request | Invalidate cached metadata/content and re-read; never serve stale cache as current |
| Missing change notification | Server changes content without notification | Document the limitation; do not claim remote version pinning or atomic freshness |
| Redirect | MCP endpoint redirects to a different host, private address, or credentialed URL | Reject by default; do not forward authorization or contact the redirect target |
| Oversized result | One response or cumulative model-request content exceeds its byte/token budget, including many small parts | Fail closed before model input; expose no partial content and log only a code |
| Concurrent reads | More reads are requested than the process limit allows; a queued caller cancels | Apply cancellable FIFO admission; remove cancelled work without network I/O |
| Human-input flow | Read returns input-required; user cancels, declines a sensitive field, or supplies an answer | Bind every round to the same request; no arbitrary URL fetch; tokenized answers only; cancellation closes or aborts the request |
| Authentication boundary | A resource contains a URL or another server's identifier | Do not resolve it or reuse the selected server's credentials |
| Cancellation and timeout | Abort during pagination, response reading, or retry | Stop work within the selected protocol's cancellation limits; do not cache partial results |
| Legacy compatibility | Exercise each enabled operation on 2025-11-25 and 2026-07-28 peers | Match only the capability matrix; unsupported methods remain unavailable and are not advertised |

All fixtures must be synthetic. Assert that raw prompt/resource content, URI
query values, OAuth values, and server error text are absent from events, spans,
logs, and captured diagnostics.

## Bounded implementation follow-ups

1. **Outbound resource discovery and reads (implemented in task 6.21).** The
   maintainer-approved per-server URI grant shape gates bounded list/read,
   subscription invalidation, cancellation, PII-boundary integration, and
   provenance. Both supported protocol revisions are covered. The client does
   not declare a `resources` capability or fetch URLs from resource content.
2. **Outbound prompt retrieval (implemented in task 6.22).** The operator-
   selected workflow uses explicit per-server prompt grants, bounded list/get,
   argument validation, PII-boundary integration, provenance, and
   prompt-injection, changed-prompt, and oversized-result tests. Completion
   remains unsupported because the workflow has no bounded completion
   requirement.
3. **Transport response limits (implemented in task 6.23).** Streamed HTTP,
   decompression, and stdio framing limits complement the decoded-data checks.
   This is separate from the resource/prompt content-access grant.

The Azure-stage wording in the source issue maps to the same-named GitHub
Actions CI jobs (`static`, `unit`, `integration`, `gates`); there is no Azure
stage in the current workflow.
