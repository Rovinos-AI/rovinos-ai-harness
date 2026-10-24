# Releasing

## npm publish surface

The npm scope is `@rovinos`. Only the SDK, CLI, and two store adapters are publishable:

| Package | Purpose |
| --- | --- |
| `@rovinos/sdk` | Stable programmatic API with internal workspace code bundled |
| `@rovinos/cli` | Bundled `harness` executable |
| `@rovinos/store-sqlite` | Optional SQLite adapter; installs `better-sqlite3` |
| `@rovinos/store-postgres` | Optional Postgres adapter; installs `pg` |

All other workspace packages stay private. The SDK and CLI have no internal workspace runtime
dependencies. They ship ESM bundles, a single declaration entry, and source maps. Third-party
runtime dependencies remain external. The SDK keeps both database drivers optional; adapter
packages install only their own driver and declare the SDK as an optional peer dependency.

Every published package requires Node.js 26 or later. The publish-surface check uses
`yarn pack --dry-run` and rejects internal package dependencies, test or `testing` files, and
tarballs above the committed uncompressed size budgets: 30 MB for the SDK, 40 MB for the CLI, and
10 MB for each adapter.

Verify the publish surface after building with:

```sh
yarn build
yarn check:publish-surface
yarn test:unit --coverage
```

The package scope and publication decision are recorded in
[ADR 0001](decisions/0001-publish-surface.md). Release publishing and versioning are configured
separately by task 21.6.
