# Branch protection

GitHub branch protection for `main` must require the Azure Pipelines status
check **Azure Pipelines / Rovinos AI Harness CI**. This is the pipeline-level
check reported by the Azure Pipelines GitHub App; its `static` and `unit` stages
run in order within that check.

The Azure DevOps pipeline must run at least once before the check appears in
GitHub's available status checks. See [Azure Pipelines setup](azure-setup.md).
When changing the pipeline identity, verify the check name in a pull request and
update this document before changing the branch-protection configuration.
