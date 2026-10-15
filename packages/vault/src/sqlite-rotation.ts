// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { hmacSha256 } from "@harness/crypto";
import { Code, Id, type KeyProvider } from "@harness/schemas";
import { normalize } from "./normalize.js";
import { VaultOperationError } from "./errors.js";
import { deriveVaultKeys, lookupMessage, type VaultKeys } from "./sqlite-crypto.js";
import { unwrapScopeKey, wrapScopeKey } from "./scope-crypto.js";
import {
  decodeVaultRotationCursor,
  encodeVaultRotationCursor,
  ReencryptBatchResultSchema,
  VaultKeyRowCountSchema,
  VaultReencryptBatchInputSchema,
  type VaultKeyRowCount,
  type VaultReencryptBatchInput,
  type ReencryptBatchResult,
} from "./rotate.js";

interface RotationRow {
  run_id: string;
  token: string;
  entity_type: string;
  value_enc: string;
  key_id: string;
  lookup_key_id: string;
}

interface EncryptedEntry {
  readonly token: string;
  readonly value_enc: string;
  readonly key_id: string;
}

interface RotationUpdate {
  readonly runId: Id;
  readonly token: string;
  readonly entityType: Code;
  readonly oldKeyId: string;
  readonly oldLookupKeyId: string;
  readonly oldValueEnc: string;
  readonly lookup: Buffer;
}

interface ScopeKeyUpdate {
  readonly scopeId: Id;
  readonly oldKeyId: string;
  readonly oldWrappedDek: Buffer;
  readonly wrappedDek: Buffer;
}

type DecryptEntry = (runId: Id, row: EncryptedEntry) => Promise<string>;

function selectRows(
  db: Database.Database,
  targetKeyId: string,
  cursor: { runId: string; token: string } | undefined,
  limit: number,
): RotationRow[] {
  return db
    .prepare<
      [string, string, string | null, string | null, string | null, string, number],
      RotationRow
    >(
      `SELECT run_id, token, entity_type, value_enc, key_id, lookup_key_id
        FROM vault_entries
        WHERE (key_id != ? OR lookup_key_id != ?)
          AND (? IS NULL OR run_id > ? OR (run_id = ? AND token > ?))
        ORDER BY run_id, token LIMIT ?`,
    )
    .all(
      targetKeyId,
      targetKeyId,
      cursor?.runId ?? null,
      cursor?.runId ?? null,
      cursor?.runId ?? null,
      cursor?.token ?? "",
      limit,
    );
}

async function encryptRows(
  rows: readonly RotationRow[],
  keyProvider: KeyProvider,
  targetKeyId: string,
  decryptEntry: DecryptEntry,
): Promise<RotationUpdate[]> {
  const targetKeys = await deriveVaultKeys(keyProvider, targetKeyId, "vault_encrypt_failed");
  const updates: RotationUpdate[] = [];
  try {
    for (const row of rows) {
      updates.push(await encryptRow(row, targetKeys, targetKeyId, decryptEntry));
    }
    return updates;
  } catch (error) {
    updates.forEach(({ lookup }) => lookup.fill(0));
    if (error instanceof VaultOperationError) {
      throw error;
    }
    throw new VaultOperationError("vault_encrypt_failed");
  } finally {
    targetKeys.encryption.fill(0);
    targetKeys.lookup.fill(0);
  }
}

async function encryptRow(
  row: RotationRow,
  targetKeys: VaultKeys,
  targetKeyId: string,
  decryptEntry: DecryptEntry,
): Promise<RotationUpdate> {
  const runId = Id.parse(row.run_id);
  const entityType = Code.parse(row.entity_type);
  const rawValue = await decryptEntry(runId, row);
  const normalizedValue = normalize(entityType, rawValue);
  const message = lookupMessage(runId, entityType, normalizedValue);
  let lookup: Buffer | undefined;
  try {
    lookup = Buffer.from(hmacSha256(targetKeys.lookup, message));
    const update = {
      runId,
      token: row.token,
      entityType,
      oldKeyId: row.key_id,
      oldLookupKeyId: row.lookup_key_id,
      oldValueEnc: row.value_enc,
      lookup,
    };
    lookup = undefined;
    return update;
  } finally {
    message.fill(0);
    lookup?.fill(0);
  }
}

function updateRows(
  db: Database.Database,
  updates: readonly RotationUpdate[],
  scopeUpdates: readonly ScopeKeyUpdate[],
  targetKeyId: string,
): number {
  const findLookupOwner = db.prepare<[Id, Code, Buffer, string], { token: string }>(
    "SELECT token FROM vault_entries WHERE run_id = ? AND entity_type = ? AND lookup = ? AND token != ?",
  );
  const update = db.prepare(
    `UPDATE vault_entries
      SET key_id = ?, lookup = ?, lookup_key_id = ?
      WHERE run_id = ? AND token = ? AND key_id = ? AND lookup_key_id = ? AND value_enc = ?`,
  );
  const rotate = db.transaction(() => {
    const processedCount = updates.reduce(
      (total, row) =>
        total +
        update.run(
          targetKeyId,
          findLookupOwner.get(row.runId, row.entityType, row.lookup, row.token) === undefined
            ? row.lookup
            : null,
          targetKeyId,
          row.runId,
          row.token,
          row.oldKeyId,
          row.oldLookupKeyId,
          row.oldValueEnc,
        ).changes,
      0,
    );
    const updateScopeKey = db.prepare(
      "UPDATE vault_scope_keys SET wrapped_dek = ?, key_id = ? WHERE scope_id = ? AND key_id = ? AND wrapped_dek = ?",
    );
    const updateScopeEntries = db.prepare("UPDATE vault_entries SET key_id = ? WHERE run_id = ?");
    for (const row of scopeUpdates) {
      if (
        updateScopeKey.run(
          row.wrappedDek,
          targetKeyId,
          row.scopeId,
          row.oldKeyId,
          row.oldWrappedDek,
        ).changes > 0
      ) {
        updateScopeEntries.run(targetKeyId, row.scopeId);
      }
    }
    return processedCount;
  });
  return rotate.immediate();
}

async function rewrapScopeKeys(
  db: Database.Database,
  rows: readonly RotationRow[],
  keyProvider: KeyProvider,
  targetKeyId: string,
): Promise<ScopeKeyUpdate[]> {
  const updates: ScopeKeyUpdate[] = [];
  const scopeIds = new Set(rows.map(({ run_id }) => Id.parse(run_id)));
  for (const scopeId of scopeIds) {
    const row = db
      .prepare<[Id], { wrapped_dek: Buffer; key_id: string }>(
        "SELECT wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = ?",
      )
      .get(scopeId);
    if (row === undefined || row.key_id === targetKeyId) {
      continue;
    }
    const dataKey = await unwrapScopeKey(keyProvider, row.key_id, scopeId, row.wrapped_dek);
    try {
      updates.push({
        scopeId,
        oldKeyId: row.key_id,
        oldWrappedDek: Buffer.from(row.wrapped_dek),
        wrappedDek: await wrapScopeKey(keyProvider, targetKeyId, scopeId, dataKey),
      });
    } finally {
      dataKey.fill(0);
    }
  }
  return updates;
}

/** Re-encrypt one bounded vault batch and rotate its lookup HMACs atomically. */
export async function reencryptVaultBatch(
  db: Database.Database,
  keyProvider: KeyProvider,
  input: VaultReencryptBatchInput,
  decryptEntry: DecryptEntry,
): Promise<ReencryptBatchResult> {
  const { targetKeyId, limit, afterCursor } = VaultReencryptBatchInputSchema.parse(input);
  const cursor = afterCursor === undefined ? undefined : decodeVaultRotationCursor(afterCursor);
  const rows = selectRows(db, targetKeyId, cursor, limit + 1);
  const selected = rows.slice(0, limit);
  const updates = await encryptRows(selected, keyProvider, targetKeyId, decryptEntry);
  let scopeUpdates: ScopeKeyUpdate[] = [];
  try {
    scopeUpdates = await rewrapScopeKeys(db, selected, keyProvider, targetKeyId);
    const processed = updateRows(db, updates, scopeUpdates, targetKeyId);
    const last = selected.at(-1);
    const nextCursor =
      rows.length > limit && last !== undefined
        ? encodeVaultRotationCursor({ runId: last.run_id, token: last.token })
        : undefined;
    return ReencryptBatchResultSchema.parse({
      processed,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
  } catch {
    throw new VaultOperationError("vault_unavailable");
  } finally {
    updates.forEach(({ lookup }) => lookup.fill(0));
    scopeUpdates.forEach(({ oldWrappedDek, wrappedDek }) => {
      oldWrappedDek.fill(0);
      wrappedDek.fill(0);
    });
  }
}

/** Count rows that still need each encryption or lookup key. */
export function countVaultRowsByKey(db: Database.Database): Promise<readonly VaultKeyRowCount[]> {
  try {
    const rows = db
      .prepare<[], { key_id: string; count: number }>(
        `SELECT key_id, COUNT(*) AS count
          FROM (
            SELECT key_id, run_id, token FROM vault_entries
            UNION
            SELECT lookup_key_id AS key_id, run_id, token FROM vault_entries
          )
          GROUP BY key_id ORDER BY key_id`,
      )
      .all();
    return Promise.resolve(
      rows.map(({ key_id, count }) => VaultKeyRowCountSchema.parse({ keyId: key_id, count })),
    );
  } catch {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }
}
