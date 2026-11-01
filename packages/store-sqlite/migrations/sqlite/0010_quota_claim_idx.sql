-- SPDX-License-Identifier: Apache-2.0
CREATE INDEX IF NOT EXISTS run_queue_active_lease_idx
  ON run_queue (lease_expires_at, run_id)
  WHERE lease_owner IS NOT NULL;
