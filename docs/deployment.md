# Deployment

The Compose configurations are starting points for local development, integration tests, and a
prod-like deployment:

- `infra/compose/docker-compose.yml` defines the shared services and their restrictive defaults.
- `infra/compose/docker-compose.dev.yml` adds the `dev` profile and loopback-published collector ports.
- `infra/compose/docker-compose.test.yml` adds the integration-test services, including PostgreSQL.
- `infra/compose/docker-compose.prod-like.yml` adds resource limits, persistent state, and graceful
  shutdown settings.

The `prod-like` harness has no published port. The control-plane HTTP server currently binds to
loopback inside the container, so a separate TLS proxy container cannot reach it. Do not publish the
control-plane directly. Network exposure and the TLS proxy example arrive with 18.5 (#178),
"Authentication, scoping, and network binding", which owns the bind host and the authentication
required for remote exposure.

## Upgrade and shutdown

Build the new harness and sandbox images before recreating services. Back up persistent state before
an upgrade that changes the event-store, vault, or workspace formats, and restore only into a
compatible release. The prod-like harness uses a 30-second Compose stop grace period and SIGTERM;
the runtime default shutdown grace is 20 seconds. Allow at least five seconds beyond the configured
`run.shutdownGraceMs` when changing either value.

## Data and backups

Compose persists the SQLite event store in `harness-event-store`, the vault in `harness-vault`, and
sandbox workspaces and their snapshots in `harness-workspaces`. Apply separate backup and retention
policies to those volumes. Use SQLite's online backup mechanism or stop the harness before copying
its database files; do not copy an active SQLite database file directly. Retain encryption keys
needed to read vault backups separately from the data, and verify restore procedures with a
non-production copy.

`HARNESS_DATA_DIR` selects the event-store directory; `HARNESS_VAULT_DATA_DIR` optionally selects
the vault directory and otherwise defaults to `HARNESS_DATA_DIR`.

## Postgres vault

Set `vault.backend` to `postgres` and configure `vault.postgres.url` with a `SecretRef`. Resolve that
reference to a Postgres URL separate from the event-store URL. The adapter rejects startup when both
URLs reach the same Postgres server and database and share either the active schema or role. This
identity check reads `pg_control_system()` on both connections; grant the harness role the required
PostgreSQL monitoring permission. A separate database is recommended; if a database is shared, use a
dedicated vault schema and role with no event-store or analytics permissions.

Grant the harness vault role access only to its vault database or schema and tables. Analytics roles
must not receive `USAGE` on the vault schema or `SELECT`/write grants on vault tables. Keep vault
credentials and master keys in the configured secret provider, not in Compose files or environment
files committed to source control.

Each root run scope has an independent random data-encryption key. The vault stores only that key's
AES-GCM-wrapped form; entry ciphertext is encrypted with the scope key. The wrapping key is derived
independently from the master key with HKDF-SHA-256 and
`info = "harness/vault/scope-wrap/v1"`; it is never reused as the value-encryption key.

Back up `vault_scope_keys` separately from `vault_entries` and retain key-table backups no longer than
the configured purge SLA. Purging deletes the live wrapped key before its entry rows. Crypto-shredding
covers entry backups or copies that do not also retain that scope's wrapped key. A pre-purge backup or
copy containing both `vault_entries` and `vault_scope_keys` still contains the wrapper and remains
decryptable with its master key; purge does not erase such a backup. Database backups and write-ahead
logs may retain historical pages, so include them in the same retention policy and keep master keys
available for the backups that must remain restorable. Key rotation re-wraps scope keys and rotates
lookup HMACs without re-encrypting every value.

## Keys and secrets

Do not put tokens, passwords, or encryption keys in Compose YAML or commit them in an env file.
The prod-like sandbox runner reads `SANDBOX_RUNNER_TOKEN_FILE` from the mounted
`sandbox_runner_token` Docker secret. Set `SANDBOX_RUNNER_TOKEN_SECRET_FILE` to a protected host-side
file before starting the prod-like profile; ensure the file is readable by the runner's runtime UID
10002. Without a valid token file the runner fails closed. Restrict access to secret files and
volumes, and rotate keys according to the deployment's retention and recovery policy. An encrypted
vault backup is not recoverable without its corresponding key material.

The test profile uses a trust-authenticated PostgreSQL instance only for synthetic integration-test
data. Do not reuse its authentication settings for a deployment.

## Known gaps

The Presidio analyzer service is not part of the current Compose inputs, and the control plane runs
inside the harness service rather than as an independently health-checked service. Compose
validation and integration checks cover services that are present; they do not imply that these
missing services have been deployed or checked.
