# Azure Pipelines setup

1. Create an Azure DevOps project and connect this GitHub repository with the
   Azure Pipelines GitHub App and a GitHub service connection.
2. Create a YAML pipeline named `Rovinos AI Harness CI` from
   `/azure-pipelines.yml` and authorize its repository access.
3. Run the pipeline once and confirm the `static` and `unit` stages appear.
   The `unit` stage publishes JUnit results and Cobertura coverage; a later run
   should report a cache hit for the Yarn cache.
4. Confirm the GitHub check is named **Azure Pipelines / Rovinos AI Harness CI**.
   Require that check for `main` as described in
   [branch protection](branch-protection.md).
5. Create a separate pipeline from `/azure-pipelines-nightly.yml`. Configure
   `HARNESS_AKV_SERVICE_CONNECTION` with its Azure service connection name and
   `HARNESS_LIVE_AKV` with a reference to the dedicated non-production test
   secret, as described in [Azure Key Vault secrets](../secrets-azure.md).

The check name combines the Azure Pipelines GitHub App and the Azure DevOps
pipeline name. Keep both stable; if either changes, update the required check in
branch protection.
