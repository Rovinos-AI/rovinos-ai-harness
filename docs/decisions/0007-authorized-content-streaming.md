# ADR 0007: Separately authorized content streaming

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decision owners:** Maintainers

## Context and threat model

The public SDK already separates metadata-only `watch` events from an explicit tokenized content
read. Applications also need incremental access to recorded content. Sending content through the
existing watch stream, safe-event projection, MCP metadata notifications, or telemetry would widen
those channels and violate their existing privacy contract.

The SDK is an embedded library and does not authenticate application users itself. An application
that exposes content to its users must bind an authenticated identity to an SDK `Principal`, enforce
run-level access, and keep that binding inside a trusted authorizer. A caller-supplied principal
without that binding is not proof of identity. An authorized client may retain any content already
delivered; the harness cannot revoke knowledge or copies held by that client.

The design protects against accidental use of the tokenized content stream by a caller that lacks
the configured authorization decision. It does not protect against a compromised host application, a
misconfigured authorizer, a client authorized for the wrong run, or a store/vault operator with
access to their configured data and keys.

## Decision

Add `Harness.streamRunContent` as a separate public API. The host application supplies a trusted
`contentAuthorizer` at harness creation. It receives a validated principal and run id, must return
an explicit allow decision, and is called before opening the stream and before every yielded
content item. Missing, throwing, or rejecting authorizers fail closed. The authorizer is the
application's boundary for authentication and run-scope policy; the SDK does not infer authority
from `requestedBy`.

The stream accepts an inclusive `fromSeq` cursor and optional `AbortSignal`. It yields only
tokenized content projected from stored events. Each item reports `durability: "committed"` because
the source is the persisted event log, not provider deltas. The stream never buffers more than one
stored event ahead of the consumer. Concurrent readers have independent iterators and cursors.

The caller must abort the signal when cancelling or immediately revoking a grant. Authorization is
also rechecked before each item; a recheck that denies or cannot decide terminates the stream before
the next item is exposed. An abort or denial cannot recall prior items. `fromSeq` identifies an event
position, not a content-item index: persist the last received `seq` and reconnect at `seq + 1`.
Reusing an earlier cursor can replay items. Retention and deletion are those of the configured event
store; the stream creates no separate retained content copy and cannot replay a removed run.

No raw reveal is available through the stream. If an application needs reveal, it must use a
separate explicitly authorized and audited operation. No content is added to `watch`, safe events,
MCP metadata notifications, or telemetry. No persisted event schema changes are made.

## Validation and known limitations

Tests cover missing and denied authorization, principal/run mismatch, reauthorization after
revocation, caller cancellation, reconnecting from a cursor, independent concurrent readers, slow
consumption, tokenized content, and the unchanged metadata-only watch path. Canary tests verify that
synthetic sensitive input is tokenized in stored events and the authorized content stream and is
absent from safe events. The repository canary gate continues to scan its captured telemetry and
logs for the synthetic canary set.

The stream does not promise replay of provider deltas that were never committed. A slow consumer
does not cause a stream-side queue to grow, but the event store's configured retention, capacity,
and availability still determine how long a reconnect cursor remains usable. Permission changes
that occur while the iterator is idle take effect immediately only when the host application aborts the
signal; otherwise they are observed before the next content item.
