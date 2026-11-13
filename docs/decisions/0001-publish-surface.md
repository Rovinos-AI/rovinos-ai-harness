# ADR 0001: npm publish surface

- **Status:** Accepted
- **Date:** 2026-10-24
- **Decision owners:** Maintainers

## Context

Publishing every workspace package would expose internal implementation details and require
coordinated versions for packages that are not intended as stable APIs. The `@harness` npm scope is
owned by another organization. Database drivers also should not be required by every SDK consumer.

## Decision

Publish only these packages under the confirmed `@rovinos` scope:

| Package | Published surface |
| --- | --- |
| `@rovinos/sdk` | Bundled stable programmatic API |
| `@rovinos/extensions` | Optional SDK-backed authoring helpers; SDK is a required peer |
| `@rovinos/extension-retrieval` | Optional bounded reference retrieval implementation; SDK and extensions are required peers |
| `@rovinos/cli` | Bundled implementation and `harness` executable |
| `@rovinos/store-sqlite` | SQLite adapter and its required driver |
| `@rovinos/store-postgres` | Postgres adapter and its required driver |
| `@rovinos/rate-limit-redis` | Optional Redis/Valkey rate-limit adapter and its client |

All other workspace packages, including the ESLint plugin, remain private. The SDK and CLI bundle
their internal workspace imports into ESM output with source maps and bundled declarations. The
extensions package is a small authoring layer over SDK-owned schemas and validation; it cannot grant
capabilities and exposes test helpers only through its explicit `/testing` subpath. The SDK has no
dependency on the helper. The Redis adapter is a separate published package so users select Redis
explicitly; the SDK and CLI refer to it through an optional peer dependency. Third-party runtime
packages remain external dependencies. The SDK lists the SQLite and Postgres drivers as optional
dependencies; each adapter lists its own driver as a regular dependency and the SDK as an optional
peer dependency.

The retrieval package is an optional lexical reference over an explicitly supplied in-memory corpus.
It has no network or vector-store dependency and remains trusted in-process code; it does not claim
plugin confinement or hosted tenant isolation.

Published packages require Node.js 26 or later. `check-publish-surface.ts` checks workspace
privacy, package dependencies, tarball contents, source maps, and uncompressed size budgets before
release. The SDK, extensions, retrieval extension, CLI, SQLite adapter, Postgres adapter, and Redis
adapter budgets are 30 MB, 1 MB, 1 MB, 40 MB, 10 MB, 10 MB, and 10 MB respectively.

The `@rovinos` npm organization must exist before the first publication. Versioning and trusted
publishing mechanics are owned by task 21.6.

## Alternatives considered

1. Publish every workspace package in one linked version group. This would enlarge the public API
   and make internal package boundaries part of every release.
2. Publish only the SDK and CLI. This would require all SDK users to install both database drivers,
   even when they use an in-memory store or only one database.

The selected surface keeps SDK and CLI installation self-contained while publishing the database
adapters separately for explicit use.
