# Provider response rehydration

Model responses may contain normalized parts alongside provider-specific `opaque` parts. Opaque
parts preserve response data that a provider needs to continue a conversation, such as Anthropic
thinking blocks and tool-use identifiers or the raw OpenAI assistant message.

Before dispatching a conversation, call `prepareMessagesForProvider(messages, provider)`. It keeps
opaque parts for the target provider and drops blobs from other providers. If an assistant message
has no matching blob, its normalized text and tool calls remain available for continuation on any
provider. Tool results continue to reference the harness-owned `callId`; adapters use the matching
opaque ID mapping when present and derive a deterministic provider ID from `callId` otherwise.

## Adapter author requirements

- Keep each opaque blob JSON-serializable and preserve every provider field needed to recreate the
  assistant response on the next request.
- Set `opaqueRoundTrip` honestly in the provider capabilities. Use `true` only when the adapter
  stores and consumes the required provider data without loss; use `false` when it cannot guarantee
  this behavior.
- Add a rehydration integration test that stores the response event through SQLite with the AES
  content codec, reads it back, prepares the next request, and compares the outgoing provider
  payload with the original response data. Include a provider-switch continuation test using
  normalized parts.

The opaque response content is part of the event content and follows the store's configured content
codec. Round-trip tests should verify both the provider-specific payload and normalized tool-call
mapping.
