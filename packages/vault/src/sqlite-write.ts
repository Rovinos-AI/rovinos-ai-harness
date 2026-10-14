// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { Code, Id } from "@harness/schemas";
import { encryptScopeValue } from "./scope-crypto.js";
import { Token, type Token as TokenValue } from "./token.js";
import { VaultOperationError } from "./errors.js";
import { VaultValueError } from "./types.js";

const MAX_TOKEN_NUMBER = 999_999;

interface ScopeKeyRow {
  scope_id: string;
  wrapped_dek: Buffer;
  key_id: string;
}

/** Prepared lookup and encryption material for the scope-locked SQLite write. */
export interface SqlitePutInput {
  readonly runId: Id;
  readonly entityType: Code;
  readonly typeName: string;
  readonly rawValue: string;
  readonly lookups: readonly Buffer[];
  readonly keyId: string;
  readonly scopeDataKey: Uint8Array;
  readonly scopeKeyId: string;
  readonly wrappedScopeKey: Buffer;
}

/** Indicates that purge or replacement changed the scope-key generation mid-write. */
export class RetryScopeKeyError extends Error {}

function insertEntry(
  db: Database.Database,
  now: () => number,
  input: {
    readonly runId: Id;
    readonly entityType: Code;
    readonly token: TokenValue;
    readonly lookup: Buffer;
    readonly encrypted: Uint8Array;
    readonly keyId: string;
    readonly lookupKeyId: string;
  },
): void {
  db.prepare(
    "INSERT INTO vault_entries (run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    input.runId,
    input.token,
    input.entityType,
    input.lookup,
    Buffer.from(input.encrypted).toString("base64"),
    input.keyId,
    input.lookupKeyId,
    now(),
  );
}

/** Commit a put only if the acquired wrapped scope-key generation is still current. */
export function putSqliteTransaction(
  db: Database.Database,
  now: () => number,
  input: SqlitePutInput,
): TokenValue {
  const put = db.transaction(() => {
    const currentScopeKey = db
      .prepare<[Id], ScopeKeyRow>(
        "SELECT scope_id, wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = ?",
      )
      .get(input.runId);
    if (
      currentScopeKey?.key_id !== input.scopeKeyId ||
      !currentScopeKey.wrapped_dek.equals(input.wrappedScopeKey)
    ) {
      throw new RetryScopeKeyError();
    }
    const findExisting = db.prepare<[Id, Code, Buffer], { token: string }>(
      "SELECT token FROM vault_entries WHERE run_id = ? AND entity_type = ? AND lookup = ?",
    );
    let existing: { token: string } | undefined;
    for (const lookup of input.lookups) {
      existing = findExisting.get(input.runId, input.entityType, lookup);
      if (existing !== undefined) {
        break;
      }
    }
    if (existing !== undefined) {
      const token = Token.safeParse(existing.token);
      if (!token.success) {
        throw new VaultOperationError("vault_unavailable");
      }
      return token.data;
    }

    const counter = db
      .prepare<[Id, string], { next_n: number }>(
        "SELECT next_n FROM vault_counters WHERE run_id = ? AND entity_type = ?",
      )
      .get(input.runId, input.typeName);
    const nextNumber = counter?.next_n ?? 1;
    if (nextNumber > MAX_TOKEN_NUMBER) {
      throw new VaultValueError("vault_token_space_exhausted");
    }
    const token = Token.safeParse(`<${input.typeName}_${String(nextNumber)}>`);
    if (!token.success) {
      throw new VaultValueError("vault_entity_type_invalid");
    }
    const encrypted = Buffer.from(
      encryptScopeValue(input.scopeDataKey, input.rawValue, `${input.runId}:${token.data}`),
      "base64",
    );
    try {
      insertEntry(db, now, {
        runId: input.runId,
        entityType: input.entityType,
        token: token.data,
        lookup: input.lookups[0] ?? Buffer.alloc(0),
        encrypted,
        keyId: input.scopeKeyId,
        lookupKeyId: input.keyId,
      });
    } finally {
      encrypted.fill(0);
    }
    db.prepare(
      "INSERT INTO vault_counters (run_id, entity_type, next_n) VALUES (?, ?, ?) ON CONFLICT(run_id, entity_type) DO UPDATE SET next_n = excluded.next_n",
    ).run(input.runId, input.typeName, nextNumber + 1);
    return token.data;
  });
  return put.immediate();
}
