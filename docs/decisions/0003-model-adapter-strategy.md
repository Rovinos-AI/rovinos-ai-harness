# ADR 0003: Model adapter strategy

- **Status:** Accepted
- **Date:** 2026-10-29
- **Decision owners:** Maintainers

## Context

The model gateway needs provider-neutral requests while keeping provider-specific response data
available for replay and for the next provider request. Task 14.1 compared the Vercel AI SDK with
thin adapters over the official Anthropic and OpenAI clients. The same text, forced-tool, and
JSON-stored multi-turn scenarios were run against both approaches using injected fixture responses;
the spike made no live provider calls.

The task specified `0001-model-adapter-strategy.md`, but `0001` is already the accepted npm publish
surface ADR. This record uses the next available number rather than replacing that decision.

## Options

1. Use `ai` with `@ai-sdk/anthropic` and `@ai-sdk/openai`, mapping the unified AI SDK messages to
   gateway types.
2. Use `@anthropic-ai/sdk` and `openai` directly, with thin adapters that map only the wire
   formats and retain raw provider fields in the gateway's opaque JSON.

## Decision

Choose thin adapters over the official provider SDKs. The AI SDK normalized the OpenAI tool
arguments into an object and serialized them again for the next request, changing the original
valid JSON string. This failed the required byte-for-byte blob round trip. Since the decision rule
prioritizes fidelity, this outweighs the AI SDK's unified API and the successful Anthropic
reasoning-block round trip.

All five packages used by the spike declare Apache-2.0 licenses. The versions are exact-pinned:
`ai@7.0.153`, `@ai-sdk/anthropic@4.0.88`, `@ai-sdk/openai@4.0.102`,
`@anthropic-ai/sdk@1.1.0`, and `openai@7.43.0`. The first three are root development
dependencies for the spike only; the official SDKs are also the versions already used by
`@rovinos/models`.

### Scenario evidence

The spike uses the same three scenarios for each provider and approach. “Multi-turn” indicates
that the follow-up call completed; the last column separately checks that the assistant's
provider-specific JSON survives serialization and rehydration unchanged.

| Approach | Provider | Plain text | Forced tool with Zod schema | JSON-stored multi-turn | Raw blob round trip |
| --- | --- | --- | --- | --- | --- |
| Thin official SDK | Anthropic | Pass | Pass | Pass | Pass |
| Thin official SDK | OpenAI | Pass | Pass | Pass | Pass |
| AI SDK | Anthropic | Pass | Pass | Pass | Pass |
| AI SDK | OpenAI | Pass | Pass | Pass | **Fail** |

For OpenAI, the recorded `function.arguments` string contains valid JSON with non-canonical
whitespace. The AI SDK converts it to a structured input and serializes it compactly on the next
request. The tool call still works, but the original provider blob is not byte-equal. For
Anthropic, the `thinking` block, signature, and tool-use ID round-trip through the AI SDK unchanged.
The fixture check covers SDK request/response mapping; it does not assert live-model behavior or
preserve the original HTTP response's whitespace.

### Comparison

| Criterion | AI SDK | Thin official SDKs |
| --- | --- | --- |
| Raw provider blob round trip | Failed OpenAI raw `function.arguments` check; passed Anthropic thinking/signature check | Passed both providers' fixture checks |
| Raw response access | `generateText` exposes normalized response messages; `response.body` was unset in the fixture run | SDK response objects retained the provider fields used by the spike |
| Abort signal | Supported through `abortSignal` | Supported through request `signal` |
| Usage reporting | Normalized usage and provider metadata | Provider usage fields are available directly |
| Retry control | `maxRetries: 0` supported per call | `maxRetries: 0` supported on each client |
| Forced tool choice | Passed both provider scenarios | Passed both provider scenarios |
| Native structured output | Available through AI SDK output APIs | Available through provider request parameters |
| Dependency weight and license | Three direct AI SDK packages; 10 new packages and 18.4 MiB in the Yarn install; all Apache-2.0 | Two official SDKs, already present in the models package; both Apache-2.0 |
| Stability | Active, fast-moving SDK/provider packages; exact pins required | Official provider clients already pinned by the models package |

## Consequences

- Provider adapters use the official SDKs and keep provider request/response mapping in the
  adapters. SDK retries remain disabled; retries and policy stay in the gateway.
- The AI SDK remains a root development dependency only so maintainers can rerun the comparison.
  The spike is outside all published workspaces and its fetch implementation returns local
  fixtures.
- Task guidance in 14.4, 14.5, and 14.6 already assumes thin adapters and needs no change:
  - **14.4 Anthropic adapter:** unchanged; retain raw content blocks and tool-use IDs.
  - **14.5 OpenAI adapter:** unchanged; preserve raw assistant messages and call IDs.
  - **14.6 OpenAI-compatible adapter:** unchanged; reuse the 14.5 mapper.

## Tasks whose guidance changes

None. Tasks 14.4–14.6 were reviewed and remain consistent with this decision.

## Validation

`node --experimental-strip-types --disable-warning=ExperimentalWarning
scripts/spikes/model-adapter-roundtrip.ts` prints the scenario table. Its mocked fetch handlers
prevent external network calls and use synthetic request and response data.
