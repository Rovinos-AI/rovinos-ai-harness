-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE vault_entries_new (
  run_id TEXT NOT NULL,
  token TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  lookup BLOB,
  value_enc TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  lookup_key_id TEXT NOT NULL,
  PRIMARY KEY (run_id, token),
  UNIQUE (run_id, entity_type, lookup)
);

INSERT INTO vault_entries_new (
  run_id, token, entity_type, lookup, value_enc, key_id, created_at, lookup_key_id
)
SELECT run_id, token, entity_type, lookup, value_enc, key_id, created_at, lookup_key_id
FROM vault_entries;

DROP TABLE vault_entries;
ALTER TABLE vault_entries_new RENAME TO vault_entries;
