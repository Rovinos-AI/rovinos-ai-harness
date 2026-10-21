-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE run_queue ADD COLUMN wake_requested INTEGER NOT NULL DEFAULT 0;
