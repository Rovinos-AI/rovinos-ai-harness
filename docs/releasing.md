# Releasing

## Versioning and GitHub releases

Create a Changeset for user-visible changes to a published package with `yarn changeset`. The SDK,
CLI, SQLite adapter, and Postgres adapter form one fixed Changesets group, so every published
package uses the same version. All other workspace packages remain private and ignored. Changesets
generates package changelogs when maintainers apply a release plan with `yarn changeset version`.

Pull requests that change package files outside Markdown documentation must include a Changeset.
The CI release dry run checks all four package archives and validates package version consistency.
The integration job builds the harness and sandbox images without pushing them.

To publish, create and push a `vX.Y.Z` tag for the matching package versions, with no unapplied
Changesets. The tag-triggered workflow runs the full CI workflow on the tagged tree, then verifies
release metadata and community files. It publishes the four packages from packed tarballs with npm
provenance through trusted publishing, builds and pushes
`ghcr.io/rovinos-ai/harness` and `ghcr.io/rovinos-ai/harness-sandbox` with version tags, signs each
image with cosign keyless signing, and attaches a BuildKit SBOM attestation. Once package publishing
succeeds, it moves the image `latest` tags and creates a GitHub Release with package changelog notes
and the Compose deployment files. Reruns skip npm versions and GitHub Releases that already exist.

Before the first release, configure the GitHub Actions trusted publisher for each npm package (see
the [npm trusted publishing guide](https://docs.npmjs.com/guides/trusted-publishers)), using
repository `Rovinos-AI/rovinos-ai-harness` and workflow `.github/workflows/release.yml`.
**Verified:** npm requires the package to exist before its trusted publisher can be configured.
Maintainers must therefore publish a one-time `0.0.0` placeholder for each package with a
short-lived npm token, then configure the trusted publisher and remove that token. Do this manually;
the release workflow never accepts or stores an npm token. Ensure the first release uses a version
newer than the placeholder.

Releases are blocked if any CI gate fails, release metadata is inconsistent, a packed package
contains an unresolved `workspace:` dependency, the community-file check with `RELEASE=1` fails, or
any build, test, publication, image-signing, or SBOM step fails. Node.js 26 or later is required for
all published packages. The release decisions are recorded in
[ADR 0002](decisions/0002-release-pipeline.md).
