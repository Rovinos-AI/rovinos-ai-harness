-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key text PRIMARY KEY,
  capacity integer NOT NULL,
  tokens double precision NOT NULL,
  refill_per_second double precision NOT NULL,
  updated_at timestamptz NOT NULL,
  last_allowed boolean NOT NULL,
  last_cost double precision NOT NULL
);
