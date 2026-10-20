-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE usage_ledger (
  quota_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('hour', 'day', 'month')),
  period_start BIGINT NOT NULL CHECK (period_start >= 0),
  cost_micros BIGINT NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  runs_started BIGINT NOT NULL DEFAULT 0 CHECK (runs_started >= 0),
  PRIMARY KEY (quota_id, period, period_start)
);
