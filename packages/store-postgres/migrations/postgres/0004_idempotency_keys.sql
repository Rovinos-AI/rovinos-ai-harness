-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key_hash text PRIMARY KEY,
  run_id text NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idempotency_keys_run_id_idx
  ON idempotency_keys (run_id);
