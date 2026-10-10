# Model provider errors

`ProviderError.retryable` indicates whether gateway resilience policies may retry the failure.
`retryAfterMs` carries a provider-requested delay when present; `status` carries the HTTP status.

| Code | Retryable | Typical HTTP status |
| --- | --- | --- |
| `provider_rate_limited` | Yes | 429 |
| `provider_timeout` | Yes | 408, 504 |
| `provider_unavailable` | Yes | 5xx |
| `provider_bad_request` | No | 400 |
| `provider_auth` | No | 401, 403 |
| `provider_content_filtered` | No | 400, 403 |
| `provider_unknown` | No | Other or unclassified |
