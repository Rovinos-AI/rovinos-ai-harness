-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE run_queue
  ADD COLUMN IF NOT EXISTS wake_requested BOOLEAN NOT NULL DEFAULT FALSE;
