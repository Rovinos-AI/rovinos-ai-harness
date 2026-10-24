# ADR 0002: versioning and release pipeline

- **Status:** Accepted
- **Date:** 2026-10-24
- **Decision owners:** Maintainers

## Context

The project needs repeatable package and container releases without long-lived registry
credentials. Releases must be tied to successful CI gates, and only the four packages selected by
ADR 0001 are public.

## Decision

- Use Changesets with one **fixed** group: `@rovinos/sdk`, `@rovinos/cli`,
  `@rovinos/store-sqlite`, and `@rovinos/store-postgres`. Other workspace packages remain private
  and are ignored by Changesets.
- Publish from a tag-triggered GitHub Actions workflow only after the tagged commit's GitHub
  `gates` check run succeeds. Use npm trusted publishing with OIDC and provenance; no npm token is
  stored in GitHub or used by the workflow.
- npm trusted publisher configuration requires an existing package. Before the first release,
  maintainers must manually publish one-time `0.0.0` placeholders with a short-lived token, then
  configure the trusted publisher and remove the token. This bootstrap is deliberately not
  automated.
- Publish container images to GHCR as `harness`, `sandbox-runner`, and `sandbox-egress-proxy`,
  tagged with the release version and `latest`. BuildKit attaches an SBOM attestation and cosign
  keyless-signs each image using the workflow's OIDC identity.
- Create a GitHub Release with package changelog notes and Compose files as assets.
- All published packages require Node.js `>=26`.

## Alternatives considered

1. Publish from Azure Pipelines. This does not provide the selected npm provenance and GitHub
   OIDC flow; GitHub Actions is used for publishing while the required GitHub `gates` check remains
   the release gate.
2. Store an npm automation token in repository secrets. Trusted publishing avoids a persistent
   npm credential.
3. Version packages independently. A fixed group keeps the public packages and container images on
   one release version.
