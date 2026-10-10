# Model provider errors

`ProviderError.retryable` indicates whether gateway resilience policies may retry the failure.
`retryAfterMs` carries a provider-requested delay when present; `status` carries the HTTP status.

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
