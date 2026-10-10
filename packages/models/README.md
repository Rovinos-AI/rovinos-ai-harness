# Model provider errors

`ProviderError.retryable` indicates whether gateway resilience policies may retry the failure.
`retryAfterMs` carries a provider-requested delay when present; `status` carries the HTTP status.

## Structured output

Pass a Zod schema as `outputSchema` in the gateway call context to validate a structured response.
The gateway selects native structured output when available, otherwise a forced `emit_result` tool
when forced tool choice is supported. The completion includes `schemaValid`, `rungUsed`, and an
`enforcement` result containing either the typed value or value-free validation issues. The
`maxRung` gateway option can cap selection at `native` or `tool`. Requests combining `outputSchema`
with real tools fail with `output_with_tools_unsupported`; providers without either supported rung
throw `rung_unavailable` for the later prompt fallback task before a provider call is made.

Gateway resilience is configured with `models.retry` (`maxAttempts: 3`,
`baseDelayMs: 500`, `maxDelayMs: 20000`, `timeoutMs: 120000`). Optional
`models.maxConcurrent` defaults to 4. Provider request rates are supplied to the
gateway by provider code through `requestsPerMinute`; bursts are capped at ten.
Rate-limit and concurrency waits use run cancellation and the run deadline;
`timeoutMs` starts when the adapter call begins. Successful responses are returned
even when the injected clock has passed the deadline; the run budget is enforced
at the next step boundary.

## Anthropic adapter

`AnthropicAdapter` implements the Messages API provider contract. Supply a resolved secret
with a `reveal()` method; the adapter disables SDK retries and retains Anthropic content blocks
in an opaque response part so thinking signatures and tool-use ids can be replayed.

| Code | Retryable | Typical HTTP status |
| --- | --- | --- |
| `provider_rate_limited` | Yes | 429 |
| `provider_timeout` | Yes | 408, 504 |
| `provider_unavailable` | Yes | 5xx |
| `provider_bad_request` | No | 400 |
| `provider_auth` | No | 401, 403 |
| `provider_content_filtered` | No | 400, 403 |
| `provider_unknown` | No | Other or unclassified |
