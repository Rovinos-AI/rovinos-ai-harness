-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS events (
  global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  content_blob TEXT NOT NULL,
  key_id TEXT,
  UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  next_seq INTEGER NOT NULL,
  last_ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS events_trace_id_idx ON events (trace_id);
CREATE INDEX IF NOT EXISTS runs_status_created_at_idx ON runs (status, created_at);
CREATE INDEX IF NOT EXISTS events_continuation_of_idx
  ON events (json_extract(meta_json, '$.continuationOf'))
  WHERE type = 'run_created';

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  at_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  meta_json TEXT NOT NULL,
  content_blob TEXT NOT NULL,
  key_id TEXT
);

CREATE INDEX IF NOT EXISTS snapshots_run_at_seq_idx ON snapshots (run_id, at_seq DESC);

CREATE TABLE IF NOT EXISTS sink_cursors (
  sink_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS store_metadata (
  metadata_key TEXT PRIMARY KEY,
  metadata_value TEXT NOT NULL
);
