-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS run_execution_leases (
  run_id TEXT PRIMARY KEY REFERENCES runs (run_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
