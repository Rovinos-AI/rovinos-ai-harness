// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { Id } from "@harness/schemas";
import type { KeyProvider } from "@harness/schemas";
import { VaultOperationError } from "./errors.js";
import { decryptSqliteEntry } from "./sqlite-decrypt.js";
import { createWrappedScopeKey, encryptScopeValue, unwrapScopeKey } from "./scope-crypto.js";
import { currentKeyId, loadMasterKey } from "./sqlite-crypto.js";

interface ScopeKeyRow {
  scope_id: string;
  wrapped_dek: Buffer;
  key_id: string;
}

interface LegacyEntryRow {
  token: string;
  value_enc: string;
  key_id: string;
}

/** Unwrapped scope key together with the bytes and version needed to validate a write. */
export interface ScopeDataKey {
  readonly dataKey: Uint8Array;
  readonly keyId: string;
  readonly wrappedDek: Buffer;
}

interface LegacyReplacement {
  readonly token: string;
  readonly oldValue: string;
  readonly oldKeyId: string;
  readonly value: string;
}

interface EnsureScopeKeyInput {
  readonly db: Database.Database;
  readonly keyProvider: KeyProvider;
  readonly now: () => number;
  readonly scopeId: Id;
  readonly masterKeyId?: string;
}

async function prepareLegacyReplacements(
  db: Database.Database,
  keyProvider: KeyProvider,
  scopeId: Id,
  dataKey: Uint8Array,
): Promise<LegacyReplacement[]> {
  const legacyRows = db
    .prepare<[Id], LegacyEntryRow>(
      "SELECT token, value_enc, key_id FROM vault_entries WHERE run_id = ?",
    )
    .all(scopeId);
  const replacements: LegacyReplacement[] = [];
  for (const row of legacyRows) {
    const rawValue = await decryptSqliteEntry(scopeId, row, keyProvider, loadMasterKey);
    replacements.push({
      token: row.token,
      oldValue: row.value_enc,
      oldKeyId: row.key_id,
      value: encryptScopeValue(dataKey, rawValue, `${scopeId}:${row.token}`),
    });
  }
  return replacements;
}

/** Acquire or transactionally install the scope key, converting any legacy rows on install. */
export async function ensureSqliteScopeDataKey(input: EnsureScopeKeyInput): Promise<ScopeDataKey> {
  const { db, keyProvider, now, scopeId } = input;
  const masterKeyId = input.masterKeyId ?? currentKeyId(keyProvider);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = db
      .prepare<[Id], ScopeKeyRow>(
        "SELECT scope_id, wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = ?",
      )
      .get(scopeId);
    if (existing !== undefined) {
      return {
        dataKey: await unwrapScopeKey(keyProvider, existing.key_id, scopeId, existing.wrapped_dek),
        keyId: existing.key_id,
        wrappedDek: Buffer.from(existing.wrapped_dek),
      };
    }

    const candidate = await createWrappedScopeKey(keyProvider, masterKeyId, scopeId);
    const wrappedDek = Buffer.from(candidate.wrappedDek);
    let committed = false;
    try {
      const replacements = await prepareLegacyReplacements(
        db,
        keyProvider,
        scopeId,
        candidate.dataKey,
      );
      const install = db.transaction(() => {
        const result = db
          .prepare(
            "INSERT INTO vault_scope_keys (scope_id, wrapped_dek, key_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope_id) DO NOTHING",
          )
          .run(scopeId, candidate.wrappedDek, masterKeyId, now());
        if (result.changes === 0) {
          return false;
        }
        const update = db.prepare(
          "UPDATE vault_entries SET value_enc = ?, key_id = ? WHERE run_id = ? AND token = ? AND value_enc = ? AND key_id = ?",
        );
        for (const row of replacements) {
          update.run(row.value, masterKeyId, scopeId, row.token, row.oldValue, row.oldKeyId);
        }
        return true;
      });
      committed = install.immediate();
    } finally {
      candidate.wrappedDek.fill(0);
      if (!committed) {
        candidate.dataKey.fill(0);
        wrappedDek.fill(0);
      }
    }
    if (committed) {
      return { dataKey: candidate.dataKey, keyId: masterKeyId, wrappedDek };
    }
  }
  throw new VaultOperationError("vault_unavailable");
}

/** Convert all legacy scopes before a writable adapter selects entry rows. */
export async function convertSqliteLegacyScopes(
  db: Database.Database,
  keyProvider: KeyProvider,
  now: () => number,
): Promise<void> {
  const scopes = db
    .prepare<[], { run_id: string }>(
      `SELECT DISTINCT entries.run_id FROM vault_entries AS entries
       WHERE NOT EXISTS (
         SELECT 1 FROM vault_scope_keys AS scope_keys WHERE scope_keys.scope_id = entries.run_id
       ) ORDER BY entries.run_id`,
    )
    .all();
  for (const { run_id } of scopes) {
    const scopeKey = await ensureSqliteScopeDataKey({
      db,
      keyProvider,
      now,
      scopeId: Id.parse(run_id),
    });
    scopeKey.dataKey.fill(0);
    scopeKey.wrappedDek.fill(0);
  }
}
