# Azure Key Vault secrets

The `akv:` reference form resolves a secret by vault name and secret name:

```yaml
models:
  apiKey: akv:my-vault/model-api-key
```

Pin a reference to a particular secret version with `#`:

```yaml
keys:
  currentKeyId: primary
  keys:
    - id: primary
      secret: akv:my-vault/harness-key-primary#0123456789abcdef0123456789abcdef
```

Vault names must start with a letter and contain 3–24 letters, digits, or hyphens. Secret names contain 1–127 letters, digits, or hyphens. Version identifiers are optional, and must contain 1–64 letters, digits, or hyphens. Invalid references are rejected before a request is made.

The resolver uses `DefaultAzureCredential` and creates a `SecretClient` for the validated `https://<vaultName>.vault.azure.net` endpoint. It caches each vault/name/version value in process memory for five minutes by default. The cache lifetime is injectable for tests. The resolver returns an opaque value that redacts normal string, JSON, and inspection output; only an explicit `reveal()` returns the value. Resolver errors contain stable codes, not Azure response bodies or secret values. Azure 404, 401/403, and other failures map to `secret_not_found`, `secret_access_denied`, and `secret_resolver_unavailable`.

The CLI registers this resolver in its default composite resolver. Embedded callers can register it explicitly:

```ts
import { CompositeSecretResolver } from "@harness/config";
import { AkvSecretResolver } from "@harness/vault";

const resolver = new CompositeSecretResolver({ akv: new AkvSecretResolver() });
```

## Content-encryption keys

`AkvKeyProvider` loads key versions from secrets named `harness-key-<keyId>`. Configure the active and historical IDs as keys and use the matching `akv:` reference for each entry. Key values must be canonical base64 encoding of exactly 32 bytes, matching the local key provider. The provider caches key bytes in memory and zeroes them when disposed.

Use Azure RBAC to grant the runtime identity only the Key Vault secret permissions it needs. Local development can use a developer identity; deployed environments should use a managed identity or workload identity supported by `DefaultAzureCredential`. Do not put secret values in configuration, logs, or pipeline YAML.

## Nightly live test

`azure-pipelines-nightly.yml` runs the `LIVE` test nightly under `AzureCLI@2`. Configure the pipeline variable `HARNESS_AKV_SERVICE_CONNECTION` with the Azure service connection name and `HARNESS_LIVE_AKV` with a reference to a dedicated, non-production test secret, for example `akv:my-vault/harness-live-probe`. Azure CLI authentication is made available to `DefaultAzureCredential` for the test step. If `HARNESS_LIVE_AKV` is unset, the test is skipped. The test checks only that the resolved value is non-empty and does not print it.

See [general secret reference guidance](secrets.md) for environment and file references.
