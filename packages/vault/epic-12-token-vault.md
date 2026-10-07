# Epic #12: Token vault

**Goal:** a run-scoped, encrypted mapping from placeholder tokens (`<EMAIL_1>`) to raw sensitive values, stored separately from the event log, with key management, rotation, purge, and auditing. Read `docs/engineering/CONVENTIONS.md` first.
**Tasks:** 12.1 to 12.8, all size S.

Shared design for this epic:
- **Separation of duties via three narrow interfaces**: `VaultWriter` (put), `VaultResolver` (resolve, used only by the detokenizer and the human UI), `VaultReader` (list raw values for a run, used only by the leak sentinel). A component receives only the interface it needs.
- The vault lives in its **own database file**, never inside the event store DB, so access can be controlled and purged independently.
- Raw values never appear in logs, spans, errors, or test snapshots. Use obviously fake values in tests (`alice@example.test`).
- Cryptographic helpers live in a new leaf package `packages/crypto` (created in 12.2) so `store` and `vault` can share them without violating the dependency rules.

---

## 12.1 Vault interfaces, token format, and in-memory implementation

**Parent:** #12 Token vault
**Task Description:** Define the token format, the three vault interfaces, normalization for idempotent tokenization, and an in-memory implementation for tests.
**Expected Inputs:** `runId`, entity type Code, raw value string.
**Expected Output:** `packages/vault/src/{types.ts,token.ts,normalize.ts,memory.ts}`, package scaffold `packages/vault`.
**Dependencies:** none.
**Items it depends on:** 7.1.
**Implementation guidance:**
1. Token format `<TYPE_N>`: `TYPE` is the entity type Code upper-cased with `-`/`.` replaced by `_` (`email` -> `EMAIL`); `N` starts at 1 per `(runId, type)` and increments. Schema `Token = z.string().regex(/^<[A-Z][A-Z0-9_]{0,31}_[1-9][0-9]{0,5}>$/)`. Export `isToken`, `findTokens(text): { token, index }[]` (global scan using the same pattern), and `tokenType(token)`.
2. Interfaces:
```ts
interface VaultWriter { put(runId: Id, entityType: Code, raw: string): Promise<Token>; }
interface VaultResolver { resolve(runId: Id, token: Token): Promise<string | undefined>; }
interface VaultReader { listRawValues(runId: Id): Promise<readonly string[]>; }
interface VaultAdmin { purge(runId: Id): Promise<number>; stats(runId: Id): Promise<{ entries: number }>; }
```
3. `put` is idempotent: the same `(runId, entityType, normalize(entityType, raw))` returns the same token. `normalize`: trim, Unicode NFKC; `email` additionally lower-cased; `phone` strips spaces, dashes and parentheses; default exact after NFKC. Document that normalization affects only token identity, not stored value (store the original trimmed value).
4. Reject empty values (`vault_value_empty`) and values over 8 KiB (`vault_value_too_large`).
5. `InMemoryVault` implements all four interfaces.
**Tests to write:** token regex valid/invalid table; idempotency including normalization cases; numbering per run and type; `resolve` unknown token returns `undefined`; purge removes entries and resets nothing else; size limits; `findTokens` on mixed text including near-miss strings (`<email_1>`, `<EMAIL_0>`).
**Acceptance Criteria:**
- [ ] Same value tokenizes to the same token within a run, different runs get independent numbering.
- [ ] Interfaces are separate so consumers can be given least privilege.
- [ ] No raw value is ever included in an error.

---

## 12.2 Encrypted SQLite vault and shared crypto package

**Parent:** #12 Token vault
**Task Description:** Persist vault entries encrypted at rest in a dedicated SQLite file, and create the shared crypto helpers.
**Expected Inputs:** `KeyProvider`, DB path.
**Expected Output:** `packages/crypto/src/{aes-gcm.ts,hkdf.ts,hmac.ts}`, `packages/vault/src/sqlite.ts`, refactor of 7.9's codec to use `packages/crypto`, CONVENTIONS layout note.
**Dependencies:** `better-sqlite3`, Node `crypto`.
**Items it depends on:** 12.1, 7.9.
**Implementation guidance:**
1. `packages/crypto` (leaf, no internal deps): `aesGcmEncrypt(key, plaintext, aad): Uint8Array` returning `iv(12) || ciphertext || tag(16)`, `aesGcmDecrypt`, `hkdfSha256(masterKey, info, length=32)`, `hmacSha256(key, data)`. Refactor 7.9's `AesGcmContentCodec` to call these; its tests must still pass.
2. Derive two keys from the provider's key for the vault using HKDF with `info = "harness/vault/enc"` and `"harness/vault/lookup"`.
3. Schema (migrated with the same migration approach as 7.12, separate migration folder `packages/vault/migrations`): `vault_entries(run_id TEXT, token TEXT, entity_type TEXT, lookup BLOB, value_enc TEXT, key_id TEXT, created_at INTEGER, PRIMARY KEY(run_id, token), UNIQUE(run_id, entity_type, lookup))`, `vault_counters(run_id TEXT, entity_type TEXT, next_n INTEGER, PRIMARY KEY(run_id, entity_type))`.
4. `lookup = HMAC-SHA256(lookupKey, runId || 0x00 || entityType || 0x00 || normalizedValue)`. Never store an unkeyed hash of the value.
5. `value_enc = base64(aesGcmEncrypt(encKey, value, aad = runId + ":" + token))`.
6. `put`: in one `BEGIN IMMEDIATE` transaction, look up by `lookup`; if found return the token; else allocate `next_n`, insert. `resolve` decrypts; decryption failure throws `vault_decrypt_failed` (no details).
7. Enable `PRAGMA secure_delete=ON`.
**Tests to write:** shared vault conformance suite (write once in `packages/vault/src/conformance.ts`, run against memory and SQLite): idempotency, numbering, resolve, purge; DB file bytes contain no plaintext canary; moving ciphertext to another `(run, token)` fails decryption; concurrent `put` of the same value from two connections yields one token; codec refactor regression tests.
**Acceptance Criteria:**
- [ ] DB file grep for the canary finds nothing.
- [ ] Concurrent puts never create duplicate tokens.
- [ ] 7.9 tests still pass after the refactor.

---

## 12.3 Local key provider with key versioning

**Parent:** #12 Token vault
**Task Description:** Implement a `KeyProvider` backed by configured secret references, supporting multiple key versions.
**Expected Inputs:** Config `keys: { currentKeyId, keys: { id: Code, secret: SecretRef }[] }`.
**Expected Output:** `packages/vault/src/local-key-provider.ts`, config fragment `packages/schemas/src/config/keys.ts`, CLI `harness keys generate`.
**Dependencies:** none.
**Items it depends on:** 7.9, 20.3.
**Implementation guidance:**
1. Implements `KeyProvider` from 7.9: `currentKeyId()` and `getKey(keyId)`. Secrets resolve through `SecretResolver` (20.3) to base64 strings that must decode to exactly 32 bytes (`key_invalid_length` otherwise).
2. Keys are resolved lazily and cached in memory as `Uint8Array`; never logged or serialized. Provide `dispose()` to zero buffers.
3. Unknown `keyId` throws `key_not_found`. `currentKeyId` must exist in `keys` (`key_current_missing`, validated at construction).
4. `harness keys generate` prints a fresh random base64 key to stdout and instructions to store it as a secret (never writes files). Mention in help text that it should be placed in env or a secret store.
5. Dev convenience: if config has no `keys` section and `NODE_ENV !== "production"`, generate an ephemeral key with a loud stderr warning (`keys_ephemeral`); in production mode fail startup.
**Tests to write:** valid key load; wrong length rejected; missing current key; rotation scenario with two keys (old key still readable); production-mode failure without keys; buffers zeroed after `dispose`; `keys generate` output decodes to 32 bytes.
**Acceptance Criteria:**
- [ ] Old keys remain readable while a new key is current.
- [ ] Production startup fails without configured keys.
- [ ] Keys never appear in logs or error messages.

---

## 12.4 Azure Key Vault provider and `akv:` secret resolver

**Parent:** #12 Token vault
**Task Description:** Add Azure Key Vault integration for key material and secret references.
**Expected Inputs:** Vault URL, secret names, Azure credentials from the environment.
**Expected Output:** `packages/vault/src/akv.ts` (`AkvKeyProvider`, `AkvSecretResolver`), registration of the `akv:` scheme in the composite resolver (20.3), docs `docs/secrets-azure.md`, nightly `LIVE` test.
**Dependencies:** `@azure/keyvault-secrets`, `@azure/identity` (verify current APIs).
**Items it depends on:** 12.3, 20.3.
**Implementation guidance:**
1. `akv:<vaultName>/<secretName>[#version]` resolves to `https://<vaultName>.vault.azure.net`. Validate the vault name with `^[a-zA-Z][a-zA-Z0-9-]{2,23}$` and secret name with `^[a-zA-Z0-9-]{1,127}$`.
2. Use `DefaultAzureCredential`; depend on an injected `SecretClientLike { getSecret(name, opts) }` interface so unit tests use a fake.
3. In-memory cache with TTL (default 300 s) keyed by `vault/name/version`; return `Secret` objects (20.3) so values never print.
4. `AkvKeyProvider`: keys stored as secrets named `harness-key-<keyId>` holding base64 32-byte values; same validation as 12.3.
5. Error mapping: 404 -> `secret_not_found`, 401/403 -> `secret_access_denied`, other -> `secret_resolver_unavailable`. Never include the response body.
6. Azure Pipelines (nightly, `LIVE`): use `AzureCLI@2` with a service connection so `DefaultAzureCredential` picks up the Azure CLI login; the test reads a dedicated test secret and skips when `HARNESS_LIVE_AKV` is unset.
**Tests to write:** fake-client unit tests for resolution, version pin, cache TTL with fake clock, error mapping, validation regexes, key provider round trip; `LIVE` test as described.
**Acceptance Criteria:**
- [ ] `akv:` refs work in config wherever a `SecretRef` is accepted.
- [ ] No secret value appears in any output or error.
- [ ] Live test documented and gated.

---

## 12.5 Key rotation: re-encrypt job and old-key read path

**Parent:** #12 Token vault
**Task Description:** Rotate encryption keys for the vault and event store content without downtime, and safely retire old keys.
**Expected Inputs:** `KeyProvider` with old and new keys, target key id.
**Expected Output:** `packages/vault/src/rotate.ts`, `packages/store/src/rotate.ts`, CLI `harness keys rotate --to <keyId> [--vault] [--store]` and `harness keys retire <keyId>`.
**Dependencies:** none.
**Items it depends on:** 12.2, 12.3, 7.9.
**Implementation guidance:**
1. Both adapters expose `reencryptBatch({ targetKeyId, limit, afterCursor })`: select rows where `key_id != target`, decrypt with the row's key, encrypt with the target, update `value_enc`/`content_blob` and `key_id` in one transaction per batch (default 500). Returns `{ processed, nextCursor }`.
2. The vault's `lookup` HMAC is derived from the key, so rotating keys changes the lookup key. Store `lookup_key_id` per row and keep lookups working by trying each referenced key id for `put` idempotency; during rotation recompute `lookup` with the target key at the same time. Document the invariant.
3. Rotation is resumable (cursor) and idempotent; running it twice is a no-op.
4. `countRowsByKey()` reports rows per `key_id`. `keys retire <id>` refuses unless the count for that id is zero in both stores (`key_in_use`).
5. Old keys remain readable (via `KeyProvider.getKey`) until retired; while rotating, new writes already use `currentKeyId`.
6. Emit only counts via the logger (`keys_rotated` with integer counts).
**Tests to write:** rotate a populated vault and store from key A to B and verify reads; interrupted rotation resumes; concurrent writes during rotation remain readable; retire refused while rows remain and allowed after; idempotent second run; lookup idempotency preserved across rotation.
**Acceptance Criteria:**
- [ ] After rotation no row references the old key.
- [ ] Retire is blocked while any row uses the key.
- [ ] Reads work throughout rotation.

---

## 12.6 Purge on run completion or retention expiry

**Parent:** #12 Token vault
**Task Description:** Delete vault entries when runs are purged or after a post-completion grace period.
**Expected Inputs:** Terminal run events, retention config, clock.
**Expected Output:** `packages/vault/src/purger.ts` (`VaultPurger`), `markTerminal(runId, ts)` on the vault admin interface, wiring into the retention job callback (7.11), config fragment `vault.purgeAfterDays` (default 7).
**Dependencies:** none.
**Items it depends on:** 12.2, 7.11.
**Implementation guidance:**
1. Add table `run_meta(run_id TEXT PRIMARY KEY, terminal_at INTEGER)` and `VaultAdmin.markTerminal(runId, ts)`. The run loop calls it on any transition to a terminal status.
2. `purgeExpired({ vault, clock, purgeAfterDays })`: purge runs whose `terminal_at < now - days*86_400_000`, in batches of 100, returning counts.
3. `onRunPurged(runId)` from the event-store retention job (7.11) calls `vault.purge(runId)` immediately regardless of the grace period.
4. Deletion uses `DELETE` with `secure_delete` on; schedule `VACUUM` after large purges (document, do not auto-run in the hot path).
5. A purged run can still be inspected (tokens remain in content) but detokenization returns `undefined`; the UI must handle this (document).
**Tests to write:** grace period boundaries with fake clock; immediate purge via hook; active runs untouched; counts reported; resolve after purge returns undefined; purge idempotent.
**Acceptance Criteria:**
- [ ] No raw values remain after purge (DB file canary grep after vacuum).
- [ ] Retention hook purges the vault in the same job run.
- [ ] Active runs are never purged.

---

## 12.7 Audit events for detokenize calls

**Parent:** #12 Token vault
**Task Description:** Record every detokenization as a metadata-only audit event.
**Expected Inputs:** Resolve calls with context (boundary, tool id).
**Expected Output:** `packages/vault/src/auditing-resolver.ts` (`AuditingVaultResolver`), `detokenized` added to the `pii_action` action enum in `@harness/schemas` and to the safe-event mapping (7.10), docs section.
**Dependencies:** none.
**Items it depends on:** 12.1, 7.10, 2.2.
**Implementation guidance:**
1. `AuditingVaultResolver(inner, onAudit)` implements `VaultResolver` with an extended `resolve(runId, token, ctx: { boundary: "tool_input"|"ui"; toolId?: Code })`. After a successful resolve it calls `onAudit({ boundary, entities: [{ type, count: 1 }] })` where `type` comes from `tokenType(token)`. Aggregate counts per call batch when a caller resolves several tokens (provide `resolveMany`).
2. The run loop turns audits into `pii_action` events with `action: "detokenized"`; the human UI path uses boundary `ui`.
3. Audit data never contains tokens, raw values, or argument names.
4. Failed resolves (unknown token) are audited as `blocked` with count only.
5. Update the enum in `events.ts`, `classification.ts`, `SafeEvent` mapping, and golden tests.
**Tests to write:** audit emitted once per resolve; batch aggregation; failure audited as `blocked`; no token or value in the audit payload (property test with canaries); schema and safe-event mapping updated.
**Acceptance Criteria:**
- [ ] Every detokenization is observable as a metadata-only event.
- [ ] Audit payloads cannot contain tokens or values.
- [ ] Human reveals are distinguishable by boundary `ui`.

---

## 12.8 Keyed-HMAC pseudonym helper

**Parent:** #12 Token vault
**Task Description:** Provide an optional, safe way to correlate the same user across runs in telemetry without exposing identifiers.
**Expected Inputs:** Identifier string, scope, `KeyProvider`.
**Expected Output:** `packages/vault/src/pseudonym.ts` (`pseudonymize`), docs `docs/telemetry/correlation.md`.
**Dependencies:** none.
**Items it depends on:** 12.3, 12.1.
**Implementation guidance:**
1. `pseudonymize({ value, scope: "global" | Id, keyProvider, keyId? }): Promise<Pseudonym>`: derive key via HKDF with `info = "harness/pseudonym"`; `mac = HMAC-SHA256(key, scope || 0x00 || normalize(value))`; take the first 16 bytes; encode as lowercase base32 without padding (26 chars); result `p_` + that string (matches the `Code` pattern).
2. `Pseudonym` schema `^p_[a-z2-7]{26}$`. Provide `attr.pseudonym()` in the telemetry attr helpers so it can be used as a registered attribute (add `harness.user.pseudonym` as an optional attribute only if an owner opts in via config `telemetry.correlation.enabled`, default false).
3. Document risks: pseudonyms are stable across runs for the same key (linkability), key rotation changes them, low-entropy inputs are safe only because the key is secret, and per-run scope gives unlinkable values.
4. Never accept a token or raw value as telemetry output; the helper is the only sanctioned way to emit a user correlation attribute.
**Tests to write:** deterministic for same inputs and key; different key, scope, or value changes output; format regex; not reversible (no raw value in output); per-run scope differs across runs; `attr.pseudonym` registered attribute accepts only the format.
**Acceptance Criteria:**
- [ ] Output always matches the pseudonym pattern.
- [ ] Disabled by default; enabling requires explicit config.
- [ ] Documentation lists the linkability risks.
