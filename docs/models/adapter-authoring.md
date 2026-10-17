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
