-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS run_queue (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'resume', 'continue')),
  run_id TEXT NOT NULL,
  priority INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  idempotency_key TEXT UNIQUE,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Only unfinished jobs live in run_queue, so this enforces one active job per run.
CREATE UNIQUE INDEX IF NOT EXISTS run_queue_run_id_idx
  ON run_queue (run_id);
CREATE INDEX IF NOT EXISTS run_queue_claim_idx
  ON run_queue (available_at, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS run_queue_dead (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'resume', 'continue')),
  run_id TEXT NOT NULL,
  priority INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  idempotency_key TEXT,
  last_error_code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dead_at INTEGER NOT NULL
);
