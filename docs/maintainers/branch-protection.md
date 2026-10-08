# Branch protection

Apply the protection for `main` from the repository root:

```sh
scripts/github/apply-branch-protection.sh --dry-run
scripts/github/apply-branch-protection.sh
```

The apply command requires the GitHub CLI (`gh`) to be authenticated with
permission to administer repository settings.

The script requires one approval, the `Azure Pipelines / Rovinos AI Harness CI`
and `DCO` checks, up-to-date branches, and resolved review conversations; force
pushes and branch deletion are disabled. The pipeline runs `yarn check:dco` in
its `static` stage. Its GitHub check name combines the Azure Pipelines app with
the pipeline name, as described in [Azure Pipelines setup](azure-setup.md).

The Azure DevOps pipeline must run at least once before its check appears in
GitHub's available status checks. Confirm both required checks exist before
enabling protection. When changing either check identity, verify its name on a
pull request and update this document and the script.
