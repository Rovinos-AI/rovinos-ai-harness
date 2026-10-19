# Pseudonymous telemetry correlation

The vault's `pseudonymize` helper can derive a telemetry-safe value from an
identifier using a key from the configured `KeyProvider`. It normalizes the
identifier by trimming it and applying Unicode NFKC, without case folding.
Changing this normalization re-keys every pseudonym. It derives a dedicated
key with HKDF-SHA-256 (empty salt, info `harness/pseudonym`), then computes
HMAC-SHA-256 over the UTF-8 bytes of `scope || 0x00 || normalizedValue`. The
first 16 digest bytes (128 bits) are encoded as lowercase RFC 4648 base32 with
padding omitted and prefixed with `p_`. The result is therefore 26 base32 characters
plus the prefix.

`pseudonymize` wraps `currentKeyId()` or `getKey()` failures in its
`PseudonymError` (`pseudonym_key_unavailable`) and rejects non-32-byte provider
results as `pseudonym_key_invalid`. These errors do not include the identifier
or the provider's error details.

Correlation is disabled unless explicitly enabled with
`telemetry.correlation.enabled: true`. Both span and log allowlist processors
enforce this setting at export: an omitted or false setting drops
`harness.user.pseudonym`, even when its schema is registered and the value is
valid. See
[`sanitize-attributes.ts`](../../packages/telemetry/src/processors/sanitize-attributes.ts).
This setting does not automatically add a user attribute to telemetry. The
`harness.user.pseudonym` key is reserved for an owner-defined span or log
attribute; no built-in definition currently registers it. An owner must
explicitly register the optional attribute with `attr.pseudonym()` and populate
it only with the helper's result.

The only supported scopes are `global` and a run ID. Global-scope pseudonyms
are stable across runs as long as the same key and normalized identifier are
used, so they enable linkability. `keyId` selects a specific provider key
version; pinning it preserves derivation only while that key remains available.
Using a different key ID after rotation changes the pseudonym and breaks
correlation with earlier values. Low-entropy identifiers are protected from
offline guessing only while the HMAC key remains secret. Use a run ID as the
scope for run-specific values; different run scopes produce unlinkable
pseudonyms for the same identifier.
