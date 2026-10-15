// SPDX-License-Identifier: Apache-2.0
import { hmacSha256 } from "@harness/crypto";
import { Code, Id, type KeyProvider } from "@harness/schemas";
import type { PoolClient, QueryResultRow } from "pg";
import { VaultOperationError } from "./errors.js";
import { normalize } from "./normalize.js";
import {
  ReencryptBatchResultSchema,
  VaultReencryptBatchInputSchema,
  decodeVaultRotationCursor,
  encodeVaultRotationCursor,
  type ReencryptBatchResult,
  type VaultReencryptBatchInput,
} from "./rotate.js";
import { decryptScopeValue, unwrapScopeKey, wrapScopeKey } from "./scope-crypto.js";
import { deriveVaultKeys, lookupMessage } from "./sqlite-crypto.js";

interface EntryRow extends QueryResultRow {
  run_id: string;
  token: string;
  entity_type: string;
  lookup: Buffer | null;
  value_enc: string;
  key_id: string;
  lookup_key_id: string;
}

interface ScopeKeyRow extends QueryResultRow {
  wrapped_dek: Buffer;
  key_id: string;
}

interface ScopeDataKey {
  readonly dataKey: Uint8Array;
  readonly keyId: string;
  readonly wrappedDek: Buffer;
}

interface RotationContext {
  readonly keyProvider: KeyProvider;
  readonly transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
}

interface EntryRotationContext {
  readonly client: PoolClient;
  readonly targetKeyId: string;
  readonly targetKey: Uint8Array;
  readonly keyProvider: KeyProvider;
  readonly scopeKeys: Map<string, ScopeDataKey>;
}

interface ReencryptRowsInput {
  readonly client: PoolClient;
  readonly context: RotationContext;
  readonly targetKeyId: string;
  readonly limit: number;
  readonly cursor: ReturnType<typeof decodeVaultRotationCursor> | undefined;
}

async function scopeDataKey(
  client: PoolClient,
  keyProvider: KeyProvider,
  scopeId: Id,
  cache: Map<string, ScopeDataKey>,
): Promise<ScopeDataKey> {
  const existing = cache.get(scopeId);
  if (existing !== undefined) {
    return existing;
  }
  const keyResult = await client.query<ScopeKeyRow>(
    "SELECT wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = $1 FOR UPDATE",
    [scopeId],
  );
  const row = keyResult.rows[0];
  if (row === undefined) {
    throw new VaultOperationError("vault_decrypt_failed");
  }
  const dataKey = await unwrapScopeKey(keyProvider, row.key_id, scopeId, row.wrapped_dek);
  const result = { dataKey, keyId: row.key_id, wrappedDek: Buffer.from(row.wrapped_dek) };
  cache.set(scopeId, result);
  return result;
}

async function rotateEntry(rotation: EntryRotationContext, row: EntryRow): Promise<number> {
  const { client, targetKeyId, targetKey, keyProvider, scopeKeys } = rotation;
  const scopeId = Id.parse(row.run_id);
  const scopeKey = await scopeDataKey(client, keyProvider, scopeId, scopeKeys);
  const entityType = Code.parse(row.entity_type);
  const rawValue = decryptScopeValue(scopeKey.dataKey, row.value_enc, `${scopeId}:${row.token}`);
  const message = lookupMessage(scopeId, entityType, normalize(entityType, rawValue));
  let lookup: Buffer | undefined;
  try {
    lookup = Buffer.from(hmacSha256(targetKey, message));
    const collision = await client.query<{ token: string } & QueryResultRow>(
      "SELECT token FROM vault_entries WHERE run_id = $1 AND entity_type = $2 AND lookup = $3 AND token <> $4",
      [scopeId, row.entity_type, lookup, row.token],
    );
    const updated = await client.query(
      `UPDATE vault_entries SET key_id = $1, lookup = $2, lookup_key_id = $1
        WHERE run_id = $3 AND token = $4 AND key_id = $5 AND lookup_key_id = $6 AND value_enc = $7`,
      [
        targetKeyId,
        collision.rows.length === 0 ? lookup : null,
        scopeId,
        row.token,
        row.key_id,
        row.lookup_key_id,
        row.value_enc,
      ],
    );
    return updated.rowCount ?? 0;
  } finally {
    message.fill(0);
    lookup?.fill(0);
  }
}

async function rewrapScopeKeys(
  client: PoolClient,
  keyProvider: KeyProvider,
  targetKeyId: string,
  scopeKeys: ReadonlyMap<string, ScopeDataKey>,
): Promise<void> {
  for (const [scope, scopeKey] of scopeKeys) {
    if (scopeKey.keyId === targetKeyId) {
      continue;
    }
    const scopeId = Id.parse(scope);
    const wrappedDek = await wrapScopeKey(keyProvider, targetKeyId, scopeId, scopeKey.dataKey);
    try {
      await client.query(
        "UPDATE vault_scope_keys SET wrapped_dek = $1, key_id = $2 WHERE scope_id = $3 AND key_id = $4 AND wrapped_dek = $5",
        [wrappedDek, targetKeyId, scopeId, scopeKey.keyId, scopeKey.wrappedDek],
      );
      await client.query("UPDATE vault_entries SET key_id = $1 WHERE run_id = $2", [
        targetKeyId,
        scopeId,
      ]);
    } finally {
      wrappedDek.fill(0);
    }
  }
}

async function reencryptRows(input: ReencryptRowsInput): Promise<ReencryptBatchResult> {
  const { client, context, targetKeyId, limit, cursor } = input;
  await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema())::bigint)");
  const selected = await client.query<EntryRow>(
    `SELECT run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id
      FROM vault_entries
      WHERE (key_id <> $1 OR lookup_key_id <> $1)
        AND ($2::text IS NULL OR run_id > $2 OR (run_id = $2 AND token > $3))
      ORDER BY run_id, token LIMIT $4`,
    [targetKeyId, cursor?.runId ?? null, cursor?.token ?? "", limit + 1],
  );
  const rows = selected.rows.slice(0, limit);
  const targetKeys = await deriveVaultKeys(
    context.keyProvider,
    targetKeyId,
    "vault_encrypt_failed",
  );
  const scopeKeys = new Map<string, ScopeDataKey>();
  let processed = 0;
  try {
    for (const row of rows) {
      processed += await rotateEntry(
        {
          client,
          targetKeyId,
          targetKey: targetKeys.lookup,
          keyProvider: context.keyProvider,
          scopeKeys,
        },
        row,
      );
    }
    await rewrapScopeKeys(client, context.keyProvider, targetKeyId, scopeKeys);
    const last = rows.at(-1);
    return ReencryptBatchResultSchema.parse({
      processed,
      ...(selected.rows.length > limit && last !== undefined
        ? { nextCursor: encodeVaultRotationCursor({ runId: last.run_id, token: last.token }) }
        : {}),
    });
  } finally {
    targetKeys.encryption.fill(0);
    targetKeys.lookup.fill(0);
    for (const scopeKey of scopeKeys.values()) {
      scopeKey.dataKey.fill(0);
      scopeKey.wrappedDek.fill(0);
    }
  }
}

/** Re-wrap scope keys and rotate lookup HMACs in one transaction. */
export function reencryptPostgresBatch(
  context: RotationContext,
  input: VaultReencryptBatchInput,
): Promise<ReencryptBatchResult> {
  const { targetKeyId, limit, afterCursor } = VaultReencryptBatchInputSchema.parse(input);
  const cursor = afterCursor === undefined ? undefined : decodeVaultRotationCursor(afterCursor);
  return context.transaction((client) =>
    reencryptRows({ client, context, targetKeyId, limit, cursor }),
  );
}
