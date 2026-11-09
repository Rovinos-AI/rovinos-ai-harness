# Model adapter authoring

`ProviderAdapter.complete()` returns one normalized `ProviderResult`.
Adapters that support streaming may also implement
`ProviderAdapter.stream(request, context)` as an `AsyncIterable<ProviderDelta>`.
The gateway collects one attempt and calls `assembleDeltas()` only after the
stream completes successfully; a failed attempt is discarded before retry.

`ProviderDelta` supports text, tool-call argument, opaque-part, usage, finish,
and content-free activity updates. Emit `activity` for provider events that
advance generation but do not produce a safe neutral delta, including private
reasoning or signatures. Never put partial reasoning or response text into an
activity delta. Emit usage as token counts only. The gateway invokes
`onProgress({ requestId, outputTokens })` for usage updates and isolates
subscriber exceptions from the provider attempt.

Only emit a finish delta after the provider confirms successful completion.
Adapters must throw a typed `ProviderError` for retryable stream failures,
including premature termination and mid-stream provider error frames. Preserve
provider-specific message metadata in the opaque part of the assembled result;
for streamed metadata, concatenate string fragments, append array fragments,
and retain the latest scalar or object value.

The collector applies `models.retry.idleTimeoutMs` between activity updates
after the first event. Streaming attempts are bounded by
`models.retry.streamTimeoutMs` (10 minutes by default) and the run deadline;
the first event is covered by the total timeout, not the idle timer. Non-streaming
attempts use `models.retry.timeoutMs`. See
[model routing](./routing.md) for provider streaming configuration.

## Provider contract matrix

The offline `runProviderContract` suites cover these adapter implementations.
The MCP column records the cross-boundary fixture coverage; it is not a claim
that other adapters cannot map tools.

| Adapter kind | Runtime model config | Offline provider contract | MCP model-to-tool round trip | Default structured output | Forced tool choice | Parallel calls | Opaque round trip |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `anthropic` | Yes | Yes | Anthropic profile | `tool` | Yes | No | Yes |
| `azure_openai` | Yes | Yes | — | `none` | No | No | No |
| `bedrock` | Yes | Yes | — | `tool` | Yes | No | Yes |
| `openai` | Yes | Yes | OpenAI profile | `native` | Yes | Yes | Yes |
| `openai_compatible` | Yes | Yes | Local-compatible profile | `json_mode` | No | No | No |
| `vertex` | No; adapter constructor only | Yes | — | `native` | No | No | No |

Capability values are the conservative defaults returned by
`lookupCapabilities`; configured provider or model overrides take precedence.
`azure_openai` currently uses the generic defaults, so enable a capability only
when the deployment supports it. OpenAI-compatible endpoints can differ by
server and model; configure capabilities and request quirks for the specific
endpoint rather than assuming OpenAI equivalence. Cassettes also use the
contract runner for record/playback behavior, but are wrappers, not adapter
kinds.

The follow-up OpenAI and local-compatible responses omit usage and normalize to
zero token counts; the Anthropic fixture supplies usage, while the Bedrock
contract explicitly rejects missing usage. Streaming-fragment and unsupported
schema behavior remains covered by the provider-specific unit suites.

Structured-output schema lowering is distinct from MCP input-schema forwarding:
OpenAI/Azure, Anthropic/Bedrock, and Vertex use different lowering rules, while
OpenAI-compatible strict-mode support is a configured endpoint quirk. The
round-trip fixture uses an input-schema subset shared by its three profiles and
asserts that the discovered schema is forwarded without alteration.

The MCP round-trip fixture is synthetic and offline. An in-memory MCP server
advertises its tool through `tools/list`; the test passes the discovered
`McpToolPort.getToolSpecs()` value to the adapter, checks that the provider
request contains the same input schema and forced choice, executes the
normalized call through the registry and policy, then sends the tool result back
as provider history. It uses OpenAI `gpt-4o-mini`, Anthropic
`claude-sonnet-5-5`, and the local-compatible `fixture-model` profile. The
responses are mocked with injected `fetch`; no live credentials or provider
requests are used. The local-compatible case exercises only that fixture
profile, not all OpenAI-compatible implementations. See
[`test/model-tool-aliases.int.test.ts`](../../test/model-tool-aliases.int.test.ts).
