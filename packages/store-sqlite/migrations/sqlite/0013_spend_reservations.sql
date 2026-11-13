-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE spend_reservations (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  estimated_micros INTEGER NOT NULL CHECK (estimated_micros >= 0),
  pricing_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatching', 'released', 'settled', 'uncertain')),
  reserved_at INTEGER NOT NULL CHECK (reserved_at >= 0),
  request_seq INTEGER NOT NULL CHECK (request_seq >= 0),
  uncertainty_code TEXT,
  settlement_json TEXT,
  CHECK (
    (state = 'uncertain' AND uncertainty_code IS NOT NULL)
    OR (state <> 'uncertain' AND uncertainty_code IS NULL)
  ),
  CHECK (
    (state = 'settled' AND settlement_json IS NOT NULL)
    OR (state <> 'settled' AND settlement_json IS NULL)
  )
);

CREATE TABLE spend_reservation_quotas (
  attempt_id TEXT NOT NULL REFERENCES spend_reservations (attempt_id) ON DELETE CASCADE,
  quota_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('day', 'month')),
  period_start INTEGER NOT NULL CHECK (period_start >= 0),
  limit_micros INTEGER NOT NULL CHECK (limit_micros >= 0),
  PRIMARY KEY (attempt_id, quota_id, period, period_start)
);

CREATE INDEX spend_reservation_quotas_period_idx
  ON spend_reservation_quotas (quota_id, period, period_start, attempt_id);
