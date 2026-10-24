# Branch protection

Apply the protection for `main` from the repository root:

```sh
scripts/github/apply-branch-protection.sh --dry-run
scripts/github/apply-branch-protection.sh --apply
```

The apply command requires the GitHub CLI (`gh`) to be authenticated with
permission to administer repository settings.

The script requires one approval, up-to-date branches, and resolved review
conversations; force pushes and branch deletion are disabled. Administrators
are not subject to these requirements (`enforce_admins` is `false`), so the
single maintainer can merge an approved Copilot PR with
`gh pr merge --admin` after reviewing it, without another administrator's
approval.

No status checks are required unless one or more `--check <context>` options are
provided. CI runs on GitHub Actions (`.github/workflows/ci.yml`), whose jobs report
the checks `static`, `unit`, `integration`, and `gates`. DCO runs as
`yarn check:dco` in the `static` job; it is not a separate status check. Require
the final job, which runs only after the others pass:

```sh
scripts/github/apply-branch-protection.sh --apply --check "gates"
```

Verify the check names on a pull request before requiring them. Repeat `--check`
for each additional status check.

## Pull requests from forks

The workflow runs only on `pull_request` with a read-only token and no secrets,
on GitHub-hosted runners. Fork runs still wait for a maintainer: under
**Settings > Actions > General > Fork pull request workflows from outside
collaborators**, select **Require approval for all outside collaborators**.
Review the diff before approving the run.
