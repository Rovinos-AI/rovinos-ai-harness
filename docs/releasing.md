# Releasing

## npm publish surface

The npm scope is `@rovinos`. The SDK, optional extensions authoring package, optional bounded reference retrieval extension, CLI, two store adapters, and optional Redis rate-limit adapter are publishable:

| Package | Purpose |
| --- | --- |
| `@rovinos/sdk` | Stable programmatic API with internal workspace code bundled |
| `@rovinos/extensions` | Optional authoring helpers over SDK-owned contracts; the SDK is a required peer |
| `@rovinos/extension-retrieval` | Optional bounded reference retrieval extension; the SDK and extensions packages are required peers |
| `@rovinos/cli` | Bundled `harness` executable |
| `@rovinos/store-sqlite` | Optional SQLite adapter; installs `better-sqlite3` |
| `@rovinos/store-postgres` | Optional Postgres adapter; installs `pg` |
| `@rovinos/rate-limit-redis` | Optional Redis/Valkey rate-limit adapter; installs `ioredis` |

All other workspace packages stay private. The SDK and CLI have no internal workspace runtime
dependencies. They ship ESM bundles, a single declaration entry, and source maps. The extensions
package externalizes its required `@rovinos/sdk` peer and keeps testing helpers
behind an explicit `/testing` export. Third-party runtime dependencies remain external. The SDK and
CLI keep their database drivers optional and declare the Redis adapter as an optional peer, so
deployments that do not configure Redis do not install a Redis client. Adapter packages install only
their own driver and declare the SDK as an optional peer dependency.
Internal peers use `workspace:^` in source manifests and are packed as `^<release version>`;
the publish-surface check verifies both forms against the fixed release group.

Every published package requires Node.js 26 or later. The publish-surface check uses
`yarn pack --dry-run` and rejects internal package dependencies, test or `testing` files (except the
intentional extensions testing subpath), and tarballs above the committed uncompressed size budgets:
30 MB for the SDK, 1 MB for each extension package, 40 MB for the CLI, and 10 MB for each adapter.

Verify the publish surface after building with:

```sh
yarn build
yarn check:publish-surface
yarn test:unit --coverage
```

The package scope and publication decision are recorded in
[ADR 0001](decisions/0001-publish-surface.md). Release publishing and versioning are configured
in the following section.

## Versioning and GitHub releases

Create a Changeset for user-visible changes to a published package with `yarn changeset add`. The
SDK, extensions, retrieval extension, CLI, SQLite adapter, Postgres adapter, and Redis adapter form one fixed Changesets
group, so every published package uses the same version. All other workspace packages remain private
and ignored. Changesets generates package changelogs when maintainers apply a release plan with
`yarn changeset version`.

Pull requests that change package files outside Markdown documentation must include a Changeset.
The CI release dry run checks all seven package archives and validates package version consistency.
The integration job builds the harness and sandbox images without pushing them.
Release packing confirms that the SDK and CLI include their generated migration trees, that the CLI
includes approval and web assets, and that each store adapter includes its own migrations. The
container build uses the repository root as its context and copies `packages/cli/dist` into the
runtime image.

To publish, create and push a `vX.Y.Z` tag for the matching package versions, with no unapplied
Changesets. The tag-triggered workflow runs the full CI workflow on the tagged tree, then verifies
release metadata and community files. It publishes the seven packages from packed tarballs with npm
provenance through trusted publishing, builds and pushes
`ghcr.io/rovinos-ai/harness` and `ghcr.io/rovinos-ai/harness-sandbox` with version tags, signs each
image with cosign keyless signing, and attaches a BuildKit SBOM attestation. Once package publishing
succeeds, it moves the image `latest` tags and creates a GitHub Release with package changelog notes
and the Compose deployment files. Reruns skip npm versions and GitHub Releases that already exist.

Before the first release, configure the GitHub Actions trusted publisher for each npm package (see
the [npm trusted publishing guide](https://docs.npmjs.com/trusted-publishers/)), using
repository `Rovinos-AI/rovinos-ai-harness` and workflow `.github/workflows/release.yml`.
**Verified:** npm requires the package to exist before its trusted publisher can be configured.
For a newly added package, maintainers must first publish a one-time `0.0.0` placeholder with a
short-lived npm token, then configure the trusted publisher for that package and remove the token.
Do this manually; the release workflow never accepts or stores an npm token. Ensure the first
release uses a version newer than the placeholder.
All seven published packages have a `0.0.0` placeholder and a trusted publisher for this repository
and workflow; a package added to the publish surface later needs the same one-time setup.

Releases are blocked if any CI gate fails, release metadata is inconsistent, a packed package
contains an unresolved `workspace:` dependency, the community-file check with `RELEASE=1` fails, or
any build, test, publication, image-signing, or SBOM step fails. Node.js 26 or later is required for
all published packages. The release decisions are recorded in
[ADR 0002](decisions/0002-release-pipeline.md).
