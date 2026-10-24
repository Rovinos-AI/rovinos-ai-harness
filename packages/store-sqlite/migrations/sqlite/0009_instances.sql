-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  heartbeat INTEGER NOT NULL CHECK (heartbeat >= 0)
);
