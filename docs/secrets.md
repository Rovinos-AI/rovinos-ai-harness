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

## Encryption keys

Configure key versions in the top-level `keys` section using `env:`, `file:`, or `akv:` references. A key secret must resolve to canonical base64 for exactly 32 bytes. Keep prior key versions configured for as long as stored data uses them. Run `harness keys generate` to create a fresh key; copy it directly to an environment variable or secret store and never commit it.

For rotation, configure the new key as `currentKeyId` first, then run `harness keys rotate --to <keyId>`. Vault rows record both `key_id` (ciphertext encryption) and `lookup_key_id` (the HMAC lookup key); rotation updates ciphertext, lookup HMAC, and both identifiers in one batch transaction. `put` checks lookup HMACs for every key id still referenced by vault rows, preserving idempotency during interrupted rotations.

(verify) Legacy vaults may contain separate tokens for the same normalized value with different HMACs. Rotation keeps both encrypted rows and their event references; when the target HMAC is already owned by another row, the duplicate is re-encrypted with a `NULL` lookup while the existing row remains canonical. New `put` calls resolve to that canonical row. Retain old keys until `harness keys retire <keyId>` confirms that neither the vault nor event store has rows that reference them.

## Vault detokenization audits

Wrap a `VaultResolver` with `AuditingVaultResolver` wherever tokens are revealed. Each successful resolve emits a `detokenized` audit record, and an unknown token emits a `blocked` record. The audit includes the run, boundary (`tool_input` or `ui`), optional tool id, and entity counts; it never includes tokens, resolved values, or argument names. A batch groups counts by entity type and outcome. The audit handler can append these metadata fields as a `pii_action` event.

`vaultAuditToPiiAction` converts an audit to the event fields accepted by the run recorder. The run-loop call site is not wired yet: task 13.5 will use the auditing resolver for allowlisted tool arguments, and task 13.7 will connect its audit handler to append the resulting `pii_action` events.
