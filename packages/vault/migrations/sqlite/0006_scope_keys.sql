-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE vault_scope_keys (
  scope_id TEXT PRIMARY KEY,
  wrapped_dek BLOB NOT NULL,
  key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
