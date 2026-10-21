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

## Scaling

`deployment.mode` defaults to `single`. In this mode, SQLite remains supported and a heartbeat in
the event-store database rejects another live runtime using the same SQLite files. The heartbeat is
refreshed every 10 seconds; a row older than 30 seconds can be reclaimed after an unclean shutdown.

Set `deployment.mode` to `multi` for a shared deployment. Every runtime must use a Postgres event
store, a Postgres vault, and a configured run queue; startup fails with
`deployment_requires_postgres` when any requirement is absent. Do not share SQLite event-store or
vault files between processes.

Configure a runner pool with one or more remote sandbox runners. Each runner still grants one run
lease at a time. The pool tries healthy runners in randomized order, skips a runner with an active
lease, and temporarily excludes a runner that fails its health check. Keep a runner assignment for
the duration of a run. On resume a different runner may be selected, in which case the workspace is
restored from the persisted snapshot.

```yaml
deployment:
  mode: multi
store:
  dialect: postgres
  connectionString: file:/run/secrets/store_database_url
vault:
  backend: postgres
  postgres:
    url: file:/run/secrets/vault_database_url
sandbox:
  runners:
    - url: http://sandbox-runner:8080
      token: file:/run/secrets/sandbox_runner_token
    - url: http://sandbox-runner-2:8080
      token: file:/run/secrets/sandbox_runner_token
```

The `prod-like` Compose profile defines two `harness-worker` replicas and two separately addressed
`sandbox-runner` services. Scale the workers with the deployment controller (or Docker Compose's
`--scale harness-worker=2`); do not scale a single runner endpoint behind a load balancer because
lease acquisition and subsequent workspace operations must reach the same runner. The worker and
runner Kubernetes manifests under `infra/k8s/` are examples, not supported deployment templates.

Workers reclaim a queued job after its lease expires if its original worker disappears. Resumption
uses the event log and snapshot, and non-idempotent tool recovery follows
`run.resume.onNonIdempotent`. A tool that performs an external side effect must provide an
idempotency mechanism or a transaction boundary appropriate to that system; a queue lease alone
cannot make an external side effect exactly once.

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
The `dev` and `prod-like` profiles accept `CONTROL_PLANE_CONFIG_FILE` and
`CONTROL_PLANE_TOKEN_SECRET_FILE`. The config file must reference the mounted token as
`file:/run/secrets/control_plane_token` under `controlPlane.auth.tokens`; HTTP starts only after that
token resolves successfully. Their safe defaults contain no configured tokens, so the harness fails
closed until both values point to protected host files. Keep those files out of source control.
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
