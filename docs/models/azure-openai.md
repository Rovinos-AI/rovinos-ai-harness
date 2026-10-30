<!-- SPDX-License-Identifier: Apache-2.0 -->
# Azure OpenAI

Configure an Azure OpenAI resource as an `azure_openai` model provider. Routed
model codes map to Azure deployment names; those codes are not inferred from
deployment names.

```yaml
models:
  providers:
    - id: azure
      kind: azure_openai
      endpoint: https://example-resource.openai.azure.com
      apiVersion: 2024-10-21
      deployments:
        gpt-4o: production-chat
      auth:
        kind: api_key
        apiKey: env:AZURE_OPENAI_API_KEY
      deploymentCapabilities:
        gpt-4o:
          structuredOutput: native
          forcedToolChoice: true
  routing:
    default:
      - provider: azure
        model: gpt-4o
```

Set `endpoint` to the HTTPS resource endpoint and `apiVersion` to an API version
supported by the resource and deployment. The adapter sends the configured
version as `api-version` and uses the mapped deployment name in the request
path. API keys are secret references and should be provided through the
configured secret resolver, not inline in the config.

For Microsoft Entra ID, replace the `auth` section with:

```yaml
      auth:
        kind: entra
```

The adapter uses `DefaultAzureCredential` with the
`https://cognitiveservices.azure.com/.default` scope. Configure that credential
chain for the process environment, for example with a managed identity in
Azure. Access tokens are cached and reacquired shortly before their expiry.

`deploymentCapabilities` is keyed by the routed logical model code. Configure
capabilities for each deployment you intend to use; the adapter does not infer
features from deployment names. Provider-wide `capabilities` can still be used
for settings shared by every mapped model.

HTTP 429 responses map to `provider_rate_limited` and preserve a valid
`Retry-After` delay. Azure content-filter errors and `content_filter` finish
reasons map to `provider_content_filtered`.
