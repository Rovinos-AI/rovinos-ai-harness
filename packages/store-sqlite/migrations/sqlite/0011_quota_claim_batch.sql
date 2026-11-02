-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE run_queue ADD COLUMN quota_rejection_reported INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS runs_running_run_id_idx
  ON runs (run_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS run_queue_quota_claim_idx
  ON run_queue (quota_rejection_reported, priority DESC, available_at, created_at, job_id);
