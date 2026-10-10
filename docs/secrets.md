# Secret references

Configuration contains references to secrets, not secret values. A secret-bearing field must use one of the supported reference forms:

| Form | Example | Resolution |
| --- | --- | --- |
| Environment variable | `env:MODEL_API_KEY` | Reads the named variable from the process environment. |
| File | `file:/run/secrets/model-api-key` | Reads UTF-8 text from an absolute file path and removes one trailing newline. |
| Azure Key Vault | `akv:my-vault/model-api-key` | The reference is validated, but resolution is unavailable until task 12.4 adds the Key Vault resolver. |

When a configuration schema defines a secret-bearing field, set that field to a reference:

```yaml
models:
  apiKey: env:MODEL_API_KEY
```

Set `MODEL_API_KEY` in the process environment or mount the value as a file and use its absolute `file:` path. Missing references fail with a stable error code; error text does not include the resolved value.

On POSIX systems, a world-readable secret file triggers the `secret_file_permissions` warning code while resolution continues. Supply a warning handler to `FileSecretResolver` to route this code to the appropriate diagnostics channel; the warning does not contain the file path or secret value.
