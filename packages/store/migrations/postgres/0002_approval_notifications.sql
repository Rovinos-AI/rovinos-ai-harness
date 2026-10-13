-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS approval_notifications (
  approval_id text PRIMARY KEY,
  run_id text NOT NULL
);

CREATE INDEX IF NOT EXISTS approval_notifications_run_id_idx
  ON approval_notifications (run_id);
