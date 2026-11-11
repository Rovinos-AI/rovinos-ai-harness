# Redis/Valkey rate-limit adapter

Install `@rovinos/rate-limit-redis` when configuring the shared request-rate backend as `redis`.
It provides an atomic token bucket using Redis server time and works with Redis or Valkey.

See [deployment rate limits](../../docs/deployment/rate-limits.md) for configuration, outage
policy, and the two-replica Compose example.
