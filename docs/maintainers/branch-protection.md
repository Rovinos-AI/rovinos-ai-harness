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
provided. DCO runs as `yarn check:dco` in the Azure pipeline's `static` stage;
it is not a separate GitHub status check. Once Azure reports the pipeline check
to GitHub, require it with:

```sh
scripts/github/apply-branch-protection.sh --apply --check "Azure Pipelines / Rovinos AI Harness CI"
```

Verify the check name on a pull request before requiring it. The name combines
the Azure Pipelines app with the pipeline name, as described in
[Azure Pipelines setup](azure-setup.md). Repeat `--check` for each additional
status check.
