-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE vault_purge_epochs (
  run_id TEXT PRIMARY KEY NOT NULL,
  purge_epoch INTEGER NOT NULL
);
