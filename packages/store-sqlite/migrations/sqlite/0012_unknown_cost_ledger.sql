-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE usage_ledger
  ADD COLUMN unknown_cost_count INTEGER NOT NULL DEFAULT 0 CHECK (unknown_cost_count >= 0);
