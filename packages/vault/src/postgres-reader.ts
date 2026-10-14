// SPDX-License-Identifier: Apache-2.0
import type { KeyProvider, VaultValueEntry } from "@harness/schemas";
import { VaultValueEntrySchema } from "@harness/schemas";
import type { Pool, QueryResultRow } from "pg";
import { VaultOperationError } from "./errors.js";
import { decryptScopeValue, unwrapScopeKey } from "./scope-crypto.js";

interface EntryRow extends QueryResultRow {
  run_id: string;
  token: string;
  entity_type: string;
  value_enc: string;
  key_id: string;
  lookup_key_id: string;
}

interface ScopeKeyRow extends QueryResultRow {
  wrapped_dek: Buffer;
  key_id: string;
}

interface ReaderContext {
  readonly pool: Pool;
  readonly keyProvider: KeyProvider;
  readonly ensureInitialized: () => Promise<void>;
}

async function readRows(context: ReaderContext, runId: string): Promise<EntryRow[]> {
  try {
    await context.ensureInitialized();
    const result = await context.pool.query<EntryRow>(
      "SELECT run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id FROM vault_entries WHERE run_id = $1 ORDER BY token",
      [runId],
    );
    return result.rows;
  } catch {
    throw new VaultOperationError("vault_unavailable");
  }
}

async function unwrapDataKey(
  context: ReaderContext,
  runId: string,
): Promise<Uint8Array | undefined> {
  const result = await context.pool.query<ScopeKeyRow>(
    "SELECT wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = $1",
    [runId],
  );
  const wrapped = result.rows[0];
  return wrapped === undefined
    ? undefined
    : unwrapScopeKey(context.keyProvider, wrapped.key_id, runId, wrapped.wrapped_dek);
}

/** Resolve a stored value with the scope key and clear key material when done. */
export async function readPostgresValue(
  context: ReaderContext,
  runId: string,
  token: string,
  valueEnc: string,
): Promise<string> {
  const dataKey = await unwrapDataKey(context, runId);
  if (dataKey === undefined) {
    throw new VaultOperationError("vault_decrypt_failed");
  }
  try {
    return decryptScopeValue(dataKey, valueEnc, `${runId}:${token}`);
  } finally {
    dataKey.fill(0);
  }
}

/** List run values with one scope-key fetch and unwrap per operation. */
export async function listPostgresValues(
  context: ReaderContext,
  runId: string,
): Promise<readonly string[]> {
  try {
    const rows = await readRows(context, runId);
    if (rows.length === 0) {
      return [];
    }
    const dataKey = await unwrapDataKey(context, runId);
    if (dataKey === undefined) {
      throw new VaultOperationError("vault_decrypt_failed");
    }
    try {
      return rows.map((row) => decryptScopeValue(dataKey, row.value_enc, `${runId}:${row.token}`));
    } finally {
      dataKey.fill(0);
    }
  } catch (error) {
    if (error instanceof VaultOperationError) {
      throw error;
    }
    throw new VaultOperationError("vault_unavailable");
  }
}

/** List typed run values with one scope-key fetch and unwrap per operation. */
export async function listPostgresValueEntries(
  context: ReaderContext,
  runId: string,
): Promise<readonly VaultValueEntry[]> {
  try {
    const rows = await readRows(context, runId);
    if (rows.length === 0) {
      return [];
    }
    const dataKey = await unwrapDataKey(context, runId);
    if (dataKey === undefined) {
      throw new VaultOperationError("vault_decrypt_failed");
    }
    try {
      return rows.map((row) =>
        VaultValueEntrySchema.parse({
          entityType: row.entity_type,
          rawValue: decryptScopeValue(dataKey, row.value_enc, `${runId}:${row.token}`),
        }),
      );
    } finally {
      dataKey.fill(0);
    }
  } catch (error) {
    if (error instanceof VaultOperationError) {
      throw error;
    }
    throw new VaultOperationError("vault_unavailable");
  }
}
