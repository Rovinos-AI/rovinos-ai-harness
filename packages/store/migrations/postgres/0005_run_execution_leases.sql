-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS run_execution_leases (
  run_id text PRIMARY KEY REFERENCES runs (run_id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  expires_at bigint NOT NULL
);
