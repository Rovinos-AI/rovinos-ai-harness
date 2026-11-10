# AGENTS.md: packages/rate-limit-redis

Optional published Redis/Valkey adapter for shared request-rate limits.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- None. See `docs/engineering/tasks/README.md`.

## Allowed internal imports

- `@rovinos/schemas`. Nothing else from `@rovinos/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Rules

- Implement the `RateLimitStore` port from `@rovinos/schemas`; do not store event or request content.
- Keep the Redis client dependency isolated to this optional adapter.
- Map connection and command failures to `RateLimitStoreUnavailableError` without exposing URLs.
- Preserve atomic token-bucket semantics and use server time for shared state.

## Testing

- Unit tests mock Redis commands; integration tests use the Valkey service in Compose.
