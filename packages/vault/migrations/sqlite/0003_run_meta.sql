-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE run_meta (
  run_id TEXT PRIMARY KEY NOT NULL,
  terminal_at INTEGER NOT NULL
);

CREATE INDEX run_meta_terminal_at_idx ON run_meta (terminal_at, run_id);
