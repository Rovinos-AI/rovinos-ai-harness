-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE spend_reservations (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  request_seq BIGINT NOT NULL CHECK (request_seq >= 0),
  estimated_micros BIGINT NOT NULL CHECK (estimated_micros >= 0),
  pricing_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatching', 'released', 'settled', 'uncertain')),
  reserved_at BIGINT NOT NULL CHECK (reserved_at >= 0),
  uncertainty_code TEXT,
  settlement JSONB,
  CHECK ((state = 'uncertain') = (uncertainty_code IS NOT NULL)),
  CHECK ((state = 'settled') = (settlement IS NOT NULL))
);

CREATE TABLE spend_reservation_quota_periods (
  attempt_id TEXT NOT NULL REFERENCES spend_reservations (attempt_id) ON DELETE CASCADE,
  quota_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('day', 'month')),
  period_start BIGINT NOT NULL CHECK (period_start >= 0),
  limit_micros BIGINT NOT NULL CHECK (limit_micros >= 0),
  PRIMARY KEY (attempt_id, quota_id, period, period_start)
);

CREATE INDEX spend_reservation_quota_periods_headroom_idx
  ON spend_reservation_quota_periods (quota_id, period, period_start, attempt_id);
