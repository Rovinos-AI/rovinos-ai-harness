-- SPDX-License-Identifier: Apache-2.0
ALTER TABLE vault_entries ADD COLUMN lookup_key_id TEXT NOT NULL DEFAULT '';

UPDATE vault_entries SET lookup_key_id = key_id WHERE lookup_key_id = '';
