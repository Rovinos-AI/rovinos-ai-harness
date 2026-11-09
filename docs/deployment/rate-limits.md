# Request rate limits

Provider and control-plane request-rate limits use the same token-bucket store. The default
`memory` backend preserves single-process behavior. It does not coordinate state across processes.

## Shared Postgres backend

For deployments with multiple replicas, use the same Postgres event-store connection and select the
Postgres rate-limit backend:

```yaml
store:
  dialect: postgres
  connectionString: file:/run/secrets/store_database_url
rateLimits:
  backend: postgres
  onUnavailable: deny
```

The Postgres backend atomically updates each bucket using database time. All replicas must share the
same database and schema to enforce one aggregate rate. Provider limits use the configured
`models.providers[].requestsPerMinute`; control-plane limits use `controlPlane.rateLimitPerMinute`.

`onUnavailable: local` is the default fallback: each replica switches to its own in-process bucket
while Postgres is unreachable. This preserves service availability but does not preserve the aggregate
rate during the outage or while replicas use separate local buckets. `onUnavailable: deny` fails
closed instead: control-plane requests receive 429 and provider requests fail with
`provider_rate_limited`. Choose explicitly based on whether availability or a strict limit is more
important. The optional Redis backend is not available until its separate adapter is installed.

## Different kinds of limits

- **Request rate** limits bound requests per minute and can be shared across replicas with Postgres.
- **Concurrency** limits bound simultaneous work; they are separate from request rates and are not
  turned into a shared concurrency ceiling by this store.
- **Spend budgets** (such as per-run `maxCostUsd` and configured quotas) account for usage or cost.
  They are not request-rate limits and continue to use their existing quota and budget controls.

Increasing a request-rate limit does not increase concurrency or spend budgets, and lowering a
concurrency limit does not change the number of requests allowed over time.
