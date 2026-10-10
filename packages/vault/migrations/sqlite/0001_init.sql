-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE vault_entries (
  run_id TEXT NOT NULL,
  token TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  lookup BLOB NOT NULL,
  value_enc TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, token),
  UNIQUE (run_id, entity_type, lookup)
);

CREATE TABLE vault_counters (
  run_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  next_n INTEGER NOT NULL,
  PRIMARY KEY (run_id, entity_type)
);
