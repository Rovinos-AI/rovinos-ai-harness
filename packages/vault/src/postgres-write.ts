// SPDX-License-Identifier: Apache-2.0
import { hmacSha256 } from "@harness/crypto";
import type { Code, Id, KeyProvider } from "@harness/schemas";
import type { PoolClient, QueryResultRow } from "pg";
import { VaultOperationError } from "./errors.js";
import { normalize } from "./normalize.js";
import { Token, type Token as TokenValue } from "./token.js";
import { createWrappedScopeKey, encryptScopeValue, unwrapScopeKey } from "./scope-crypto.js";
import { deriveVaultKeys, lookupMessage } from "./sqlite-crypto.js";
import { VaultValueError } from "./types.js";

const MAX_TOKEN_NUMBER = 999_999;

interface ScopeKeyRow extends QueryResultRow {
  wrapped_dek: Buffer;
  key_id: string;
}

interface ScopeDataKey {
  readonly dataKey: Uint8Array;
  readonly keyId: string;
  readonly wrappedDek: Buffer;
}

/** Scope and normalized value inputs required for a transactional Postgres put. */
export interface PutInput {
  readonly runId: Id;
  readonly entityType: Code;
  readonly rawValue: string;
  readonly typeName: string;
  readonly keyId: string;
  readonly lookupKey: Uint8Array;
}

interface WriteContext {
  readonly keyProvider: KeyProvider;
  readonly now: () => number;
}

function safeInteger(value: number | string | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new VaultOperationError("vault_unavailable");
  }
  return parsed;
}

function entryToken(value: string): TokenValue {
  const parsed = Token.safeParse(value);
  if (!parsed.success) {
    throw new VaultOperationError("vault_unavailable");
  }
  return parsed.data;
}

async function scopeKey(
  context: WriteContext,
  client: PoolClient,
  scopeId: Id,
  keyId: string,
): Promise<ScopeDataKey> {
  const existing = await client.query<ScopeKeyRow>(
    "SELECT wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = $1 FOR UPDATE",
    [scopeId],
  );
  const row = existing.rows[0];
  if (row !== undefined) {
    const dataKey = await unwrapScopeKey(context.keyProvider, row.key_id, scopeId, row.wrapped_dek);
    return { dataKey, keyId: row.key_id, wrappedDek: Buffer.from(row.wrapped_dek) };
  }
  const candidate = await createWrappedScopeKey(context.keyProvider, keyId, scopeId);
  let installed = false;
  try {
    const inserted = await client.query(
      "INSERT INTO vault_scope_keys (scope_id, wrapped_dek, key_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (scope_id) DO NOTHING RETURNING scope_id",
      [scopeId, candidate.wrappedDek, keyId, context.now()],
    );
    if (inserted.rows.length > 0) {
      installed = true;
      return { dataKey: candidate.dataKey, keyId, wrappedDek: Buffer.from(candidate.wrappedDek) };
    }
  } finally {
    candidate.wrappedDek.fill(0);
    if (!installed) {
      candidate.dataKey.fill(0);
    }
  }
  const raced = await client.query<ScopeKeyRow>(
    "SELECT wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = $1 FOR UPDATE",
    [scopeId],
  );
  const racedRow = raced.rows[0];
  if (racedRow === undefined) {
    throw new VaultOperationError("vault_unavailable");
  }
  return {
    dataKey: await unwrapScopeKey(
      context.keyProvider,
      racedRow.key_id,
      scopeId,
      racedRow.wrapped_dek,
    ),
    keyId: racedRow.key_id,
    wrappedDek: Buffer.from(racedRow.wrapped_dek),
  };
}

async function lookupKeys(
  context: WriteContext,
  client: PoolClient,
  input: PutInput,
): Promise<Buffer[]> {
  const result = await client.query<{ lookup_key_id: string } & QueryResultRow>(
    "SELECT DISTINCT lookup_key_id FROM vault_entries WHERE run_id = $1 ORDER BY lookup_key_id",
    [input.runId],
  );
  const message = lookupMessage(
    input.runId,
    input.entityType,
    normalize(input.entityType, input.rawValue),
  );
  const lookups: Buffer[] = [];
  try {
    const keyIds = Array.from(
      new Set([input.keyId, ...result.rows.map(({ lookup_key_id }) => lookup_key_id)]),
    );
    for (const keyId of keyIds) {
      if (keyId === input.keyId) {
        lookups.push(Buffer.from(hmacSha256(input.lookupKey, message)));
        continue;
      }
      const oldKeys = await deriveVaultKeys(context.keyProvider, keyId, "vault_encrypt_failed");
      try {
        lookups.push(Buffer.from(hmacSha256(oldKeys.lookup, message)));
      } finally {
        oldKeys.encryption.fill(0);
        oldKeys.lookup.fill(0);
      }
    }
    return lookups;
  } catch (error) {
    lookups.forEach((lookup) => lookup.fill(0));
    throw error;
  } finally {
    message.fill(0);
  }
}

/** Insert a value under the caller's scope transaction lock. */
export async function putPostgresEntry(
  context: WriteContext,
  client: PoolClient,
  input: PutInput,
): Promise<TokenValue> {
  const { runId, entityType, rawValue, typeName, keyId } = input;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runId]);
  const key = await scopeKey(context, client, runId, keyId);
  let lookups: Buffer[] = [];
  try {
    lookups = await lookupKeys(context, client, input);
    for (const lookup of lookups) {
      const existing = await client.query<{ token: string } & QueryResultRow>(
        "SELECT token FROM vault_entries WHERE run_id = $1 AND entity_type = $2 AND lookup = $3",
        [runId, entityType, lookup],
      );
      const token = existing.rows[0]?.token;
      if (token !== undefined) {
        return entryToken(token);
      }
    }
    await client.query(
      "INSERT INTO vault_counters (run_id, entity_type, next_n) VALUES ($1, $2, 1) ON CONFLICT (run_id, entity_type) DO NOTHING",
      [runId, typeName],
    );
    const allocated = await client.query<{ next_n: number | string } & QueryResultRow>(
      "UPDATE vault_counters SET next_n = next_n + 1 WHERE run_id = $1 AND entity_type = $2 RETURNING next_n - 1 AS next_n",
      [runId, typeName],
    );
    const number = safeInteger(allocated.rows[0]?.next_n);
    if (number < 1 || number > MAX_TOKEN_NUMBER) {
      throw new VaultValueError("vault_token_space_exhausted");
    }
    const token = Token.safeParse(`<${typeName}_${String(number)}>`);
    if (!token.success) {
      throw new VaultValueError("vault_entity_type_invalid");
    }
    const lookup = lookups[0];
    if (lookup === undefined) {
      throw new VaultOperationError("vault_encrypt_failed");
    }
    const valueEnc = encryptScopeValue(key.dataKey, rawValue, `${runId}:${token.data}`);
    const inserted = await client.query<{ token: string } & QueryResultRow>(
      `INSERT INTO vault_entries
        (run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (run_id, entity_type, lookup) DO NOTHING RETURNING token`,
      [runId, token.data, entityType, lookup, valueEnc, key.keyId, keyId, context.now()],
    );
    const insertedToken = inserted.rows[0]?.token;
    if (insertedToken !== undefined) {
      return entryToken(insertedToken);
    }
    for (const candidate of lookups) {
      const duplicate = await client.query<{ token: string } & QueryResultRow>(
        "SELECT token FROM vault_entries WHERE run_id = $1 AND entity_type = $2 AND lookup = $3",
        [runId, entityType, candidate],
      );
      const duplicateToken = duplicate.rows[0]?.token;
      if (duplicateToken !== undefined) {
        return entryToken(duplicateToken);
      }
    }
    throw new VaultOperationError("vault_unavailable");
  } finally {
    key.dataKey.fill(0);
    key.wrappedDek.fill(0);
    lookups.forEach((lookup) => lookup.fill(0));
  }
}
