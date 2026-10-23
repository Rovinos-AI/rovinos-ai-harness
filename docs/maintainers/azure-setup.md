# Azure Key Vault nightly test

GitHub Actions (`.github/workflows/ci.yml`) is the only pull request CI. The
Azure pipeline is retained only for the scheduled live Key Vault test.

Create an Azure DevOps pipeline from `/azure-pipelines-nightly.yml` and configure
`HARNESS_AKV_SERVICE_CONNECTION` with its Azure service connection name and
`HARNESS_LIVE_AKV` with a reference to the dedicated non-production test secret,
as described in [Azure Key Vault secrets](../secrets-azure.md).

This nightly pipeline does not create a required branch-protection check. Require
the GitHub Actions `gates` job as described in
[branch protection](branch-protection.md).
