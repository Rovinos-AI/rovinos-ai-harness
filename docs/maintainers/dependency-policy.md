# Dependency update policy

Dependabot checks the Yarn workspace and the root Dockerfile weekly. Minor and
patch updates are grouped, and each ecosystem can have at most five open update
pull requests. Review each pull request and its CI results before merging.

Major updates to `zod` and `@modelcontextprotocol/*` are intentionally ignored
because they affect cross-package and protocol compatibility. To consider one,
review the compatibility impact, remove only that dependency's
`version-update:semver-major` ignore entry from `.github/dependabot.yml`, and
merge the configuration change before relying on Dependabot to open the update
pull request. Keep Yarn package-manager updates ignored; update the `packageManager`
field through a separately reviewed change.

The DCO check requires a valid `Signed-off-by` trailer on ordinary commits.
Dependabot's exemption in `config/dco-exemptions.json` is limited to its exact
author and GitHub committer identities and the pinned GitHub signing key. The
check only accepts that exemption when the commit has a verified signature from
the configured key; do not broaden it to unsigned bot commits.
