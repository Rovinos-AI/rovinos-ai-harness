// SPDX-License-Identifier: Apache-2.0
/** Initial SQLite schema; task 7.12 replaces this with versioned migrations. */
export const SQLITE_SCHEMA = `
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
`;
