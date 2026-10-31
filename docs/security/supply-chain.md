# Software supply chain

## Pull requests

For pull requests and release tags, the independent `image-scan` job builds the harness and sandbox
images into local Docker archives. Unit tests do not wait for this job. It does not push images, sign
them, or publish anything. Pinned Syft and Trivy containers read those archives without mounting the
Docker socket. Syft writes a CycloneDX JSON SBOM for each final image. Trivy scans the named
`runtime-os-audit` build stage for OS packages before the final runtime removes the Debian package
database, and scans the final image for language packages. The audit stage and final stage share the
same runtime base and setup. Trivy's OS report must contain at least one OS package; otherwise
`scripts/security/scan-image.ts` fails with `image_os_packages_missing`. Scanner findings are
normalized and evaluated with the shared policy evaluator from `scripts/security/vuln-policy.ts`.
The required `gates` job checks that `image-scan` succeeded before running downstream gates.

The image policy is [`config/image-vuln-policy.json`](../../config/image-vuln-policy.json). Fixable
HIGH and CRITICAL findings block the job; unknown severities fail closed, and less severe fixable
findings are reported as warnings.
Findings without a fixed version are retained in the scanner report but are not blockers. Exceptions
must identify an advisory or package, include an owner and reason, and have a future expiry date.
Expired exceptions fail the gate. The static job also runs a recorded vulnerable-report positive
control to confirm the parser and evaluator continue to reject a seeded fixable HIGH finding.
SBOMs and scanner/evaluation reports are uploaded as the
`image-sbom-and-vulnerability-reports` artifact.

## Releases

The tag-triggered [`release.yml`](../../.github/workflows/release.yml) workflow already builds and
pushes the two release images with BuildKit `--sbom=true` and `--provenance=true`. It reads each
image digest from BuildKit's metadata and runs `cosign sign` on `image@sha256:...`, not on a tag.
Cosign uses GitHub Actions keyless signing with the workflow OIDC identity; no signing key is stored
in the repository. BuildKit attaches an SPDX in-toto SBOM attestation to the image index. The
workflow moves `latest` tags only after signing the versioned images. The release workflow waits for
the reusable CI workflow, whose independent `image-scan` job builds and scans both Dockerfiles before
publishing starts. This is a pre-publish scan of the same image build inputs, not a rescan of the
pushed digest.

To verify a published release image, pass its registry reference and immutable digest:

```sh
scripts/security/verify-image.sh --verify ghcr.io/rovinos-ai/harness@sha256:<64-hex-digest>
```

The verifier checks the cosign certificate identity for this repository's release workflow and the
GitHub Actions OIDC issuer. It then checks the signed image index for its BuildKit attestation
manifest, fetches the referenced in-toto blob from GHCR, verifies its content digest and checks the
SPDX statement's subject against the runnable image manifest referenced by that signed index. The
image signature covers the signed index and therefore its attestation reference; this check does not
validate the SBOM's completeness against source code.
The verifier requires Node.js 26+, `cosign`, Docker's image tools, and `curl`.

## Scope and known gaps

Trivy updates its vulnerability database while scanning, so image scans require registry/database
network access and can change findings as advisories are published. Scanner versions are pinned by
image digest, but the vulnerability database is intentionally current rather than pinned. The
CycloneDX reports generated for PRs and the BuildKit SPDX attestations generated for releases are
different formats. The PR job is a pre-publish check; only release tags produce registry images and
keyless signatures. Verification is tied to the configured release workflow identity and version-tag
certificate identity pattern. The release builder currently emits one runnable platform manifest;
multi-platform releases need verification of each runnable manifest and its corresponding
attestation.
