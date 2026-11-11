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
important.

## Optional Redis/Valkey backend

Install `@rovinos/rate-limit-redis` only when Redis or Valkey is selected (for example,
`yarn add @rovinos/rate-limit-redis`). Without this optional adapter, single-node memory and shared
Postgres deployments do not install a Redis client. All replicas must use the same Redis/Valkey
endpoint and `keyPrefix` to enforce one aggregate request rate:

```yaml
rateLimits:
  backend: redis
  onUnavailable: deny
  redis:
    url: file:/run/secrets/rate_limit_redis_url
    keyPrefix: harness-prod
    tls: true
```

`redis.url` is a `SecretRef`, not a literal connection URL. Use a `rediss:` URL or set `tls: true`
for managed services. The store runs one atomic Lua token-bucket update using Redis server time.
Buckets are namespaced as `<keyPrefix>:rl:<key>` and expire after twice their full-refill duration.
The Redis store is coordination state only; the event log remains the source of truth.

`onUnavailable: local` falls back to one local bucket per replica during an outage, so it does not
preserve the aggregate rate and can multiply the effective limit. `onUnavailable: deny` fails closed
instead. Use `deny` when the aggregate request-rate ceiling must hold during a backend partition.
This setting affects request-rate limits only; it does not change concurrency limits or spend
budgets.

The two-replica example in
[`infra/compose/docker-compose.replicas.yml`](../../infra/compose/docker-compose.replicas.yml)
extends the Postgres-backed production-like topology and adds shared Valkey. Supply a config that
selects `backend: redis` and a secret file containing `redis://valkey:6379/0`. The example enables
the Docker build argument `WITH_REDIS_RATE_LIMIT=1` to install the adapter and its client; ordinary
images leave it disabled. Start it with:

```sh
docker compose \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.prod-like.yml \
  -f infra/compose/docker-compose.replicas.yml \
  --profile prod-like up --scale harness=2
```

To exercise the aggregate ceiling across two independent clients against the shared Valkey service,
run `yarn test:integration packages/rate-limit-redis/src/rate-limit.int.test.ts`.

## Different kinds of limits

- **Request rate** limits bound requests per minute and can be shared across replicas with Postgres or
  the optional Redis/Valkey adapter.
- **Concurrency** limits bound simultaneous work; they are separate from request rates and are not
  turned into a shared concurrency ceiling by this store.
- **Spend budgets** (such as per-run `maxCostUsd` and configured quotas) account for usage or cost.
  They are not request-rate limits and continue to use their existing quota and budget controls.

Increasing a request-rate limit does not increase concurrency or spend budgets, and lowering a
concurrency limit does not change the number of requests allowed over time.
