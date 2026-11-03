# ADR 0004: Lossless MCP tool results and artifact references

- **Status:** Accepted
- **Date:** 2026-11-03
- **Decision owners:** Maintainers

## Context

`packages/mcp/src/tool-result.ts` currently normalizes result content into JSON, but reduces resource
blocks to byte metadata and omits resource-link fields. It also exposes only the first large binary
payload. `packages/mcp/src/tool-port.ts` then returns that byte array instead of the normalized
mixed result. The outer `OffloadingToolPort` in `packages/context/src/offload.ts` stores one complete
JSON result and replaces it with one stub; its current reader is text-oriented. These paths cannot
represent multiple independently retrievable binary parts alongside their text and structured data.

The existing server setting `maxResultBytes` defaults to 1 MiB and bounds the serialized normalized
result. The existing `WorkspacePort` writes and reads individual files below `.harness/offload/`.
The `tool_result` event is currently version 1; its `result` is classified as content and is read
through pure event upcasters. These existing mechanisms are useful starting points, but the
multi-artifact write and authorization contract is not yet defined.

## Proposed contract

1. Define one strict, schema-first `McpToolResultEnvelope` in `@rovinos/schemas`. It has a format
   discriminator and contract version, `isError`, an ordered `parts` array, and optional
   `structuredContent` and result metadata. A zero-part result is valid. Keep structured content
   separate from the ordered content array; do not flatten, infer, or reorder it.
2. Preserve each supported SDK part's semantic fields. This includes text; image, audio and blob
   MIME type and data; embedded-resource URI, MIME type and text or blob; resource-link URI, name,
   and any other supported optional fields; and annotations/metadata. Resource-link URIs and names
   are content, not safe diagnostics. Do not fetch or open a resource link. Reject malformed
   encodings, unsupported part types, or unsupported fields with stable error codes rather than
   silently mapping them to `unknown` or dropping them.
3. Keep the array order as the canonical part order. A binary artifact reference replaces only the
   binary data of its own part, so companion text, structured content, links, annotations, and other
   binary parts remain in the envelope. Each offloaded part carries an opaque handle, MIME type,
   decoded byte count, and SHA-256 digest. The digest is for integrity checks, not a telemetry
   attribute. Small binary parts may remain inline under the existing threshold; large parts each
   receive a separate reference.
4. Apply `maxResultBytes` (1 MiB by default) to the UTF-8 serialized inline envelope after artifact
   substitution. Count all parts, references, and structured content together. Add a per-server
   `maxArtifactBytes` cap (50 MiB by default) over the combined decoded bytes of all offloaded parts.
   Check encoded lengths before decoding/copying; reject envelope overflow with `result_too_large`
   and artifact overflow with `artifact_too_large`.
5. Treat artifact handles as references, not authority. Reads must be authorized by the active
   run's workspace boundary; a handle from another run must not grant access. Artifact bytes and
   resource URIs remain content, never telemetry or error text. Apply existing PII/storage controls
   before persistence. Binary parts are blocked by default with `mcp_binary_result_blocked`.
   Operators may set `binaryResults: allow` per server. Allowed binary artifacts are stored
   without tokenization in the run workspace as an explicit exception to the files-carry-tokens rule.
   Vault-key encryption is a follow-up; this decision does not add it.

## Offload and failure semantics

Extend the existing workspace artifact mechanism with an all-or-nothing batch write for the set of
large binary parts in one result. `OffloadingToolPort` should replace each corresponding `data` field
with its artifact reference and must not replace the complete MCP envelope with a single generic
offload stub. The next model request and the event log receive the complete ordered envelope with
references, not raw offloaded bytes. Artifact reads remain explicit tool operations; no URI is
dereferenced by normalization or offloading.

If any part fails validation, exceeds the aggregate cap, or cannot be persisted, do not return a
partially referenced result. Return a closed, metadata-only error code and no partial envelope. A
batch implementation must either publish every artifact or publish none; if the existing
`WorkspacePort` cannot provide that guarantee, add an explicit transactional artifact capability
before enabling multi-part offload. An already-error MCP result still preserves its complete
content when validation and storage succeed; an artifact-write failure takes precedence and yields
the stable offload error. Orphan cleanup and retention policy must be defined by the artifact
implementation, not by exposing partial references.

## Event versioning and replay

Changing the persisted `tool_result.result` shape requires bumping `tool_result` from v1 to v2 in
`packages/schemas/src/event-versions.ts`, adding a pure v1-to-v2 upcaster, updating field
classification as needed, and adding a legacy fixture plus `yarn check:event-schema` coverage.
Upcast a legacy result to an explicitly tagged legacy JSON variant containing its exact original
value; do not guess which old values were binary or recreate content already lost by the former
first-payload path. Upcasting is read-only and never rewrites stored rows. New result envelopes and
legacy results must both be passed intact to the next model step.

## Required validation after approval

- Unit tests: ordered mixed content; multiple large binaries; mixed inline/offloaded parts; text
  with structured content; resource-link URI/name; empty and error results; malformed encodings;
  aggregate limit; atomic batch failure.
- Integration tests: persist and reload every part/reference, enforce run-scoped reference
  authorization, and supply the reloaded result to the next model step without omissions.
- Replay/canary tests: v1 legacy fixture and upcast; no raw binary, URI, or digest in telemetry;
  no automatic link fetch; current and historical events replay without data loss.

## Alternatives considered

1. Keep one offload stub for the complete MCP result. This cannot keep companion parts visible and
   cannot identify multiple binary payloads, so it does not meet the lossless contract.
2. Change the persisted result shape without changing the event version. This leaves replay unable
   to distinguish legacy JSON from the new envelope, so a `tool_result` version bump is required.
3. Fetch resource-link URIs during normalization. This would turn untrusted content into network
   authority and is explicitly out of scope.

## Follow-up

Encrypt allowed binary artifacts with the run's vault key while retaining run-scoped reference
authorization and integrity verification.
