-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS control_plane_consumed_states (
  state_id text PRIMARY KEY,
  expires_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS control_plane_consumed_states_expires_at_idx
  ON control_plane_consumed_states (expires_at);
