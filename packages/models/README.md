# Model provider errors

`ProviderError.retryable` indicates whether gateway resilience policies may retry the failure.
`retryAfterMs` carries a provider-requested delay when present; `status` carries the HTTP status.

Gateway resilience is configured with `models.retry` (`maxAttempts: 3`,
`baseDelayMs: 500`, `maxDelayMs: 20000`, `timeoutMs: 120000`). Optional
`models.maxConcurrent` defaults to 4. Provider request rates are supplied to the
gateway by provider code through `requestsPerMinute`; bursts are capped at ten.
Rate-limit and concurrency waits use run cancellation and the run deadline;
`timeoutMs` starts when the adapter call begins. Successful responses are returned
even when the injected clock has passed the deadline; the run budget is enforced
at the next step boundary.

| Code | Retryable | Typical HTTP status |
| --- | --- | --- |
| `provider_rate_limited` | Yes | 429 |
| `provider_timeout` | Yes | 408, 504 |
| `provider_unavailable` | Yes | 5xx |
| `provider_bad_request` | No | 400 |
| `provider_auth` | No | 401, 403 |
| `provider_content_filtered` | No | 400, 403 |
| `provider_unknown` | No | Other or unclassified |
