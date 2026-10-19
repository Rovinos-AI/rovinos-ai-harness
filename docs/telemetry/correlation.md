# Pseudonymous telemetry correlation

The vault's `pseudonymize` helper can derive a telemetry-safe value from an
identifier using a key from the configured `KeyProvider`. It normalizes the
identifier with the vault's identity normalization, derives a dedicated key
with HKDF-SHA-256 (`harness/pseudonym`), and returns a truncated HMAC-SHA-256
digest encoded as a `p_`-prefixed base32 string. Use `attr.pseudonym()` when
registering a span attribute; never put a raw identifier or vault token in
telemetry.

Correlation is disabled unless explicitly enabled with
`telemetry.correlation.enabled: true`. This setting only permits the feature;
it does not automatically add a user attribute to spans. A span owner must
explicitly register and populate the optional `harness.user.pseudonym`
attribute, using only the helper's result.

Global-scope pseudonyms are stable across runs as long as the same key and
normalized identifier are used, so they enable linkability. Rotating to a
different key changes the pseudonym and breaks correlation with earlier values.
Low-entropy identifiers are protected from offline guessing only while the
HMAC key remains secret. Use a run ID as the scope for run-specific values;
different run scopes produce unlinkable pseudonyms for the same identifier.
