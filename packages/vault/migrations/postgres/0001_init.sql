-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS vault_scope_keys (
  scope_id text PRIMARY KEY,
  wrapped_dek bytea NOT NULL,
  key_id text NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_entries (
  run_id text NOT NULL,
  token text NOT NULL,
  entity_type text NOT NULL,
  lookup bytea,
  value_enc text NOT NULL,
  key_id text NOT NULL,
  lookup_key_id text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (run_id, token),
  UNIQUE (run_id, entity_type, lookup)
);

CREATE TABLE IF NOT EXISTS vault_counters (
  run_id text NOT NULL,
  entity_type text NOT NULL,
  next_n bigint NOT NULL,
  PRIMARY KEY (run_id, entity_type)
);

CREATE TABLE IF NOT EXISTS vault_purge_epochs (
  run_id text PRIMARY KEY,
  purge_epoch bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS run_meta (
  run_id text PRIMARY KEY,
  terminal_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS run_meta_terminal_at_idx ON run_meta (terminal_at, run_id);
