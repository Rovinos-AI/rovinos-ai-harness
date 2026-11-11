---
"@rovinos/sdk": patch
"@rovinos/cli": patch
"@rovinos/rate-limit-redis": patch
---

# Add Redis/Valkey request-rate limiting

The optional Redis adapter provides shared atomic token buckets. SDK and CLI deployments without
the adapter continue to use memory or Postgres without installing a Redis client.
