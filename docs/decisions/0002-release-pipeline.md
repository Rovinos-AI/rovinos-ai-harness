# ADR 0002: versioning and release pipeline

- **Status:** Accepted
- **Date:** 2026-10-24
- **Decision owners:** Maintainers

## Context

The project needs repeatable package and container releases without long-lived registry
credentials. Releases must be tied to CI gates run on the tagged tree, and only the four packages
selected by ADR 0001 are public.

## Decision

- Use Changesets with one **fixed** group: `@rovinos/sdk`, `@rovinos/cli`,
  `@rovinos/store-sqlite`, and `@rovinos/store-postgres`. Other workspace packages remain private
  and are ignored by Changesets.
- Publish from a tag-triggered GitHub Actions workflow that calls the full reusable CI workflow on
  the tagged tree before release verification. Use npm trusted publishing with OIDC and provenance;
  no npm token is stored in GitHub or used by the workflow.
- npm trusted publisher configuration requires an existing package. Before the first release,
  maintainers must manually publish one-time `0.0.0` placeholders with a short-lived token, then
  configure the trusted publisher and remove the token. This bootstrap is deliberately not
  automated.
- Publish the two Compose images to GHCR as `harness` and `harness-sandbox`, tagged with the release
  version; move `latest` only after versioned images and npm packages publish. BuildKit attaches an
  SBOM attestation and cosign keyless-signs each image using the workflow's OIDC identity.
- Publish npm packages from packed tarballs after rejecting any packed manifest with unresolved
  `workspace:` ranges. Reruns skip package versions and GitHub Releases that already exist.
- Create a GitHub Release with package changelog notes and Compose files as assets.
- All published packages require Node.js `>=26`.

## Alternatives considered

1. Publish from Azure Pipelines. This does not provide the selected npm provenance and GitHub
   OIDC flow; GitHub Actions publishes after rerunning CI on the tagged tree.
2. Store an npm automation token in repository secrets. Trusted publishing avoids a persistent
   npm credential.
3. Version packages independently. A fixed group keeps the public packages and container images on
   one release version.
