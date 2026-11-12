# Governed outbound MCP resources and prompts (6.18)

This is a design, not an implementation. Standalone outbound resource discovery
and reads, and prompt listing and retrieval, must not be advertised or exposed
until the follow-up work below is approved and implemented. Resource blocks
embedded in `tools/call` results continue through the existing tool-result
handling path; this design does not change that behavior. The inventory was
checked against current `origin/main`, the pinned MCP TypeScript SDK v2.4.0
declarations, and protocol baselines in
[engineering conventions](engineering/CONVENTIONS.md#10-external-protocol-and-sdk-baseline).

## Capability matrix

“Implemented” describes current harness behavior, not merely an SDK method.
Protocol versions are the modern 2026-07-28 revision and the legacy 2025-11-25
revision negotiated by the existing SDK client and server transports.

| Capability | Outbound client, modern | Outbound client, legacy | Inbound control-plane server, modern | Inbound control-plane server, legacy |
| --- | --- | --- | --- | --- |
| Tools list/call | Implemented | Implemented | Implemented | Implemented |
| Resources list/read | Unsupported now; planned follow-up | Unsupported now; planned follow-up | Implemented; run resources are permission-checked | Implemented; run resources are permission-checked |
| Resource subscriptions/updates | Unsupported | Unsupported | Implemented for subscribed run-resource updates | Implemented for subscribed run-resource updates |
| Prompts list/get | Unsupported now; planned follow-up, subject to consumer review | Unsupported now; planned follow-up, subject to consumer review | Unsupported | Unsupported |
| Completions | Unsupported | Unsupported | Unsupported | Unsupported |

The client uses tool discovery and configured elicitation capabilities; it does
not declare resource or prompt support. The control-plane server registers
resources with per-request authorization and supports resource subscriptions.
Neither role registers or consumes prompts. Although SDK v2.4.0 exposes
`listResources`, `readResource`, `listPrompts`, `getPrompt`, and `complete`,
their existence does not make those features implemented. Completions have no
identified harness consumer, so they are unsupported and not planned. No
capability in this matrix is experimental. Sampling, Roots, Logging, and
deprecated HTTP+SSE remain out of scope.

The client resource rows refer to standalone discovery/read APIs. Resource
blocks embedded in `tools/call` results already pass through the existing
result-normalization and content-processing path.

## Proposed access and data contract

These are decisions for implementation follow-ups, not current configuration
or public APIs.

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

1. **Outbound resource discovery and reads.** Add only after maintainer review of
   the public grant/config shape and capability declarations. Implement
   per-server URI grants, bounded list/read, subscription invalidation,
   cancellation, PII-boundary integration, provenance, and the resource cases
   above. Do not add direct URL fetching or advertise capability before the
   tests pass on both protocol revisions.
2. **Outbound prompt retrieval.** Add separately after identifying a concrete
   workflow and reviewing the public prompt-selection/argument contract.
   Implement explicit per-server prompt grants, bounded list/get, argument
   validation, PII-boundary integration, provenance, and prompt-injection,
   changed-prompt, and oversized-result tests. Do not add completion support
   unless that workflow identifies a specific consumer and bounded requirement.
3. **Transport response limits (prerequisite if needed).** If SDK v2.4.0
   buffers responses before the proposed decoded-data check, implement and test
   streamed HTTP, decompression, and stdio framing limits before describing the
   limits as wire- or memory-bounded. This is separate from the resource/prompt
   content-access grant.

The Azure-stage wording in the source issue maps to the same-named GitHub
Actions CI jobs (`static`, `unit`, `integration`, `gates`); there is no Azure
stage in the current workflow. In this docs-only design task, the requested
tests are specified above rather than implemented as runtime tests. This task
does not change production capability declarations, schemas, or package APIs.
