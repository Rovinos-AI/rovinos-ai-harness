-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS runs (
  run_id text PRIMARY KEY,
  created_at bigint NOT NULL,
  status text NOT NULL,
  next_seq bigint NOT NULL,
  last_ts bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  global_seq bigserial PRIMARY KEY,
  run_id text NOT NULL,
  seq bigint NOT NULL,
  ts bigint NOT NULL,
  type text NOT NULL,
  trace_id text NOT NULL,
  span_id text NOT NULL,
  segment_id text NOT NULL,
  meta jsonb NOT NULL,
  content_blob text NOT NULL,
  key_id text,
  tx_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE (run_id, seq)
);

ALTER TABLE events ADD COLUMN IF NOT EXISTS tx_id xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX IF NOT EXISTS events_trace_id_idx ON events (trace_id);
CREATE INDEX IF NOT EXISTS events_continuation_of_idx ON events ((meta ->> 'continuationOf')) WHERE type = 'run_created';
CREATE INDEX IF NOT EXISTS runs_status_created_at_idx ON runs (status, created_at);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id text PRIMARY KEY,
  run_id text NOT NULL,
  at_seq bigint NOT NULL,
  created_at bigint NOT NULL,
  meta_json jsonb NOT NULL,
  content_blob text NOT NULL,
  key_id text
);

CREATE INDEX IF NOT EXISTS snapshots_run_at_seq_idx ON snapshots (run_id, at_seq DESC);

CREATE TABLE IF NOT EXISTS sink_cursors (
  sink_id text PRIMARY KEY,
  cursor bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS store_metadata (
  metadata_key text PRIMARY KEY,
  metadata_value text NOT NULL
);
