# ADR 0009: Typed multi-modal parts and artifact interoperability

- **Status:** Proposed
- **Date:** 2026-11-09
- **Decision owners:** Maintainers
- **Scope:** Design only; no runtime, event-schema, or provider-support change is approved by this ADR.

## Context

The normalized model contract in `packages/schemas/src/messages.ts` currently has text, tool-call,
tool-result, and provider-specific opaque parts. It has no provider-neutral image, audio, or document
part. Provider adapters map text and tool exchanges, and some retain provider-native response
content as opaque JSON for same-provider round trips. That opaque preservation does not mean another
provider can interpret the content.

MCP has a separate artifact path. `McpToolResultEnvelope` preserves ordered JSON-safe result parts,
while binary payloads are passed to the offload layer as separate artifacts. Binary results are
blocked by default; the configured aggregate artifact limit defaults to 50 MiB, and the normalized
result limit defaults to 1 MiB. Artifact handles are scoped to a run workspace, and allowed artifact
bytes are encrypted. The accepted [ADR 0004](./0004-mcp-result-envelope.md) documents those
semantics. It does not yet define a shared model-part contract or imply that a stored artifact is
provider-readable.

The concrete workflows for a future common contract are:

1. A user asks a model about one or more attached images, preserving each image as a separate,
   ordered input part.
2. A user supplies audio for transcription or audio understanding, and a model may return generated
   audio as a distinct output part. A text transcript is text, not an implicit replacement for the
   source audio.
3. A user supplies a document (for example, a PDF) for interpretation. The document remains a
   document reference unless a separately specified extraction step produces text or page images.
4. An MCP tool returns multiple binary items and companion text or structured data. Each binary item
   remains separately addressable; the next model step may receive a reference only if its adapter
   supports that modality and is authorized to read it.

These are design inputs, not claims that current adapters support the workflows.

## Proposed contract

Use one strict, schema-first `ModelPartSchema` in `@rovinos/schemas`, with its TypeScript type
inferred from the schema. Extend the existing part union additively; do not make adapters accept
provider SDK types as the shared contract. The proposed v1 variants are:

| Variant | Proposed fields | Meaning |
| --- | --- | --- |
| `text` | Existing `text` | Text as text; never encode binary data or artifact URIs in this field. |
| `tool_call`, `tool_result`, `opaque` | Existing fields | Preserve current semantics. `opaque` remains provider-specific and is not portable modality support. |
| `image` | `artifact: ArtifactReferenceV1`, optional bounded `altText` | One image part. The reference does not assert that a selected provider can interpret it. |
| `audio` | `artifact: ArtifactReferenceV1`, optional closed purpose hint | One audio part. Purpose distinguishes requested handling; it does not imply transcription or generation support. |
| `document` | `artifact: ArtifactReferenceV1`, optional bounded page selection | One document part. Extraction and page rendering are explicit transforms, not implicit adapter behavior. |

`ArtifactReferenceV1` is a versioned, JSON-safe reference, not the bytes and not an authorization
credential:

```json
{
  "format": "harness-artifact-ref",
  "version": 1,
  "handle": "opaque run-scoped handle",
  "mimeType": "image/png",
  "bytes": 12345,
  "sha256": "64 lowercase hexadecimal characters",
  "provenance": {
    "source": "user_input | mcp_tool | model_output | derived"
  }
}
```

The `format` and `version` make reference interpretation explicit. `handle` is opaque and must not
be dereferenced as a URI. `mimeType`, decoded byte count, and digest describe the stored object;
they do not grant read permission. Provenance is a closed source classification, optionally
extended with stable producer codes after review; it must not contain user text, prompts, URLs, or
credentials. The existing MCP reference (`handle`, `mimeType`, `bytes`, `sha256`) can be adapted
without changing its meaning; a future implementation must explicitly version any persisted shape
change rather than reinterpret old references.

The part list and reference together preserve message role, order, and multiplicity. A part may
contain inline text, or refer to one stored artifact, but it must not contain both a binary payload
represented as text and a reference. `ModelPartV1` and `ArtifactReferenceV1` are design names, not
independently authored schemas: implementation must choose one canonical strict schema per contract
and infer its TypeScript types.

## Limits and failure behavior

Use MIME allowlists by modality, not a permissive `image/*` or `audio/*` wildcard. Start with
explicitly reviewed formats (initial candidates: PNG/JPEG/WebP for images; WAV/MP3/OGG for audio;
PDF for documents). Reject mismatched or unknown MIME types; do not sniff and silently relabel
content. Expand the allowlist only with adapter fixtures and a security review.

For the first implementation, retain the existing MCP ceilings as proposed defaults: 1 MiB for
the serialized result/reference envelope and 50 MiB aggregate decoded artifact bytes per tool
result. Also cap a single artifact at the aggregate cap. A model request that combines artifacts
from multiple sources must enforce a total decoded-byte budget before reading or copying any
payload. Propose 1 MiB for the serialized model-content/reference envelope and 50 MiB aggregate
resolved bytes per request as initial ceilings; owners must confirm these defaults against consumer
workflows and provider constraints before implementation. Provider-specific lower limits may reject
a request, but must never increase these harness-wide limits implicitly.

Return closed, content-free errors rather than flattening, dropping, or logging an unsupported part:

| Condition | Proposed error code |
| --- | --- |
| Adapter cannot interpret a requested modality or operation | `model_modality_unsupported` |
| Reference is absent or not visible in the active run | `model_artifact_unavailable` |
| Reference has expired or its run has been purged | `model_artifact_expired` |
| Caller lacks permission to read the artifact | `model_artifact_access_denied` |
| MIME type is not approved for the part or adapter | `model_artifact_mime_unsupported` |
| Per-artifact or aggregate byte budget is exceeded | `model_artifact_too_large` |
| Serialized request/reference envelope is too large | `model_request_too_large` |

The errors expose only a stable code and safe numeric metadata. They must not include bytes, MIME
parameters derived from untrusted input, URI/handle values, provider response text, or user content.
An unsupported modality is not a retryable provider failure by default. A configured fallback may
be selected only when its reviewed capability declaration covers every requested part and
operation; otherwise fail before sending the request.

## Adapter capability matrix (current implementation)

This matrix describes the gateway's current normalized mapping, not the public feature set of the
underlying model vendors. Support varies by model, deployment, endpoint, API version, and provider
configuration; no provider/model capability has been confirmed for this proposed contract.

| Adapter | Current normalized request behavior | Typed image input | Typed audio input | Typed document input |
| --- | --- | --- | --- | --- |
| Anthropic | Maps text and tool exchanges; preserves provider-native response blocks as opaque data. | Not implemented | Not implemented | Not implemented |
| OpenAI | Chat Completions mapper handles text and tools; opaque provider data can round-trip. | Not implemented | Not implemented | Not implemented |
| Azure OpenAI | Uses the OpenAI Chat Completions mapping with deployment configuration. | Not implemented | Not implemented | Not implemented |
| OpenAI-compatible | Uses the OpenAI-compatible mapping; endpoint behavior is not inferred. | Not implemented | Not implemented | Not implemented |
| Bedrock Converse | Maps text and tool exchanges; retains provider-specific opaque data. | Not implemented | Not implemented | Not implemented |
| Vertex Gemini | Maps text and tool exchanges; retains provider-specific opaque data. | Not implemented | Not implemented | Not implemented |
| Cassette/replay | Stores or replays JSON contracts; does not interpret artifacts. | Not applicable | Not applicable | Not applicable |

The existing `Capabilities` object covers structured output, tool choice, parallel tools, context
tokens, and opaque round-trip behavior. It must not be used as evidence for modality support.
Before an adapter is marked supported, add explicit per-modality and per-operation capability
declarations at the appropriate model/deployment scope. Unknown means unsupported for routing until
the declaration and adapter contract tests exist. Distinguish input from output, and audio
transcription from audio perception or generation.

## Access, privacy, and retention

1. Artifact references are identifiers only. Resolve them through one artifact resolver after
   authorizing the active run, caller, and requested operation. A reference copied from another run
   must not grant access. Do not fetch HTTP(S), MCP resource-link, or other external URIs while
   normalizing or resolving a reference.
2. Persist artifact bytes only in the existing encrypted, run-scoped artifact boundary. Persist
   references and typed parts—not raw bytes or base64—in events, snapshots, cassettes, replay
   fixtures, logs, or telemetry. Keep raw bytes in memory only while validating, encrypting,
   explicitly reading, or sending them to an authorized provider.
3. Apply the existing PII boundary before content is persisted. Binary bytes are not text-tokenized;
   any extracted OCR, transcription, caption, or other text is separately tokenized before
   persistence or onward model/tool use. Store only synthetic binary content in tests.
4. Artifacts inherit the owning run's retention and purge lifecycle; they must not outlive the run.
   Purge artifact bytes and associated keys/references together. Reads after expiration or purge
   fail with a stable code; do not recreate artifacts from a digest or stale reference. Temporary
   upload retention before run creation remains an explicit follow-up, not an implicit extension.
5. Keep digests and byte counts in content-bearing references only. They are integrity/budget
   metadata, not telemetry attributes. Events and diagnostics must not expose raw URIs, handles,
   digests, bytes, extracted text, or content-derived error strings.

These rules complement, and do not weaken, the run-scoped authorization and encryption decisions
in ADR 0004.

## Replay and migration

Do not silently rewrite old `Part` values or infer a modality from `opaque.blob`, MCP metadata, MIME
strings, or a URI. The old value remains an opaque legacy part and replays unchanged. A future
implementation that changes an existing persisted event payload must bump that event's version,
add a pure upcaster and a legacy fixture, and pass `yarn check:event-schema`. New event types start
at v1. Model cassettes and serialized references need explicit contract-version handling as well;
old cassettes must either replay as legacy JSON or fail with a closed incompatibility code.

## Validation required before implementation is approved

- Schema unit tests: strict shape and version checks; unknown fields; unsupported MIME; malformed
  reference; invalid byte counts/digests; ordered parts; multiple artifact references.
- Adapter contract tests: per-provider/model fixture cases for each declared modality and operation,
  explicit unsupported cases, model/deployment overrides, and no flattening or omission on downgrade.
- Artifact integration tests: active-run authorization, cross-run denial, expired and purged
  references, encrypted persistence/reload, batch atomicity, and aggregate/per-artifact limits.
- Replay tests: old opaque/provider-specific parts remain byte-for-byte replayable; new references
  replay without fetching URIs; changed event payloads use the required upcaster and legacy fixture.
- Privacy negative controls: sentinel raw bytes/base64, artifact handles, URIs, digests, OCR text,
  and transcripts do not enter telemetry, logs, errors, or event metadata. Assert request limits
  before large buffers are allocated.
- Canary tests: multiple references preserve neighboring text and structured data, and no
  unsupported part is silently dropped or converted to text.

## Implementation sequence after owner approval

1. Approve this ADR's part/reference contract, MIME allowlist, limits, and lifecycle rules.
2. Add the canonical schemas and inferred types in `@rovinos/schemas`; decide exact `ModelRequest`
   and `ModelResponse` serialization points and document event/cassette version consequences.
3. Review artifact resolver interoperability with storage and MCP owners; implement run/caller
   authorization, encryption, byte budgets, and coordinated retention before exposing model reads.
4. Add explicit capability declarations and tests for one adapter/model family at a time. No
   provider is advertised as supported until its fixture contract passes; add opt-in live tests
   only where credentials and policy permit.
5. Add replay, event upcasting where needed, privacy canaries, and user-facing documentation.

This ADR approves no runtime implementation, provider capability claim, or event migration.
