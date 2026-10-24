// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { Id } from "@rovinos/schemas";
import { InvalidEventError, parseIdempotencyKeyTakeover } from "@rovinos/store/adapter-internal";
import { sqliteStoreError } from "./outbox.js";
import {
  IdempotencyKeyHashSchema,
  type IdempotencyKeyHash,
  type IdempotencyKeyTakeoverOptions,
} from "@rovinos/store/adapter-internal";

/**
 * Persist or retrieve a hashed idempotency claim in SQLite.
 * @param db Database connection for the target store.
 * @param keyHash Digest associated with the key.
 * @param runId Candidate run identifier.
 * @param createdAt Claim time in epoch milliseconds.
 * @returns Candidate run id or the id already associated with the key.
 */
export function claimSqliteIdempotencyKey(
  db: Database.Database,
  keyHash: IdempotencyKeyHash,
  runId: Id,
  createdAt: number,
): Promise<Id> {
  const parsedHash = IdempotencyKeyHashSchema.safeParse(keyHash);
  const parsedRunId = Id.safeParse(runId);
  if (!parsedHash.success || !parsedRunId.success) {
    return Promise.reject(new InvalidEventError([["idempotencyKey"]]));
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    return Promise.reject(new InvalidEventError([["createdAt"]]));
  }
  try {
    const claim = db.transaction(() => {
      db.prepare<[string, Id, number]>(
        "INSERT INTO idempotency_keys (key_hash, run_id, created_at) VALUES (?, ?, ?) ON CONFLICT (key_hash) DO NOTHING",
      ).run(parsedHash.data, parsedRunId.data, createdAt);
      const row = db
        .prepare<[string], { run_id: string }>(
          "SELECT run_id FROM idempotency_keys WHERE key_hash = ?",
        )
        .get(parsedHash.data);
      if (row === undefined) {
        throw new InvalidEventError([["idempotencyKey"]]);
      }
      return Id.parse(row.run_id);
    });
    return Promise.resolve(claim.immediate());
  } catch (error) {
    return Promise.reject(sqliteStoreError(error));
  }
}

/**
 * Release an idempotency claim only while the supplied run id owns it.
 * @param db Database connection for the target store.
 * @param keyHash Digest associated with the key.
 * @param runId Run id expected to own the claim.
 */
export function releaseSqliteIdempotencyKey(
  db: Database.Database,
  keyHash: IdempotencyKeyHash,
  runId: Id,
): Promise<void> {
  const parsedHash = IdempotencyKeyHashSchema.safeParse(keyHash);
  const parsedRunId = Id.safeParse(runId);
  if (!parsedHash.success || !parsedRunId.success) {
    return Promise.reject(new InvalidEventError([["idempotencyKey"]]));
  }
  try {
    db.prepare<[string, Id]>("DELETE FROM idempotency_keys WHERE key_hash = ? AND run_id = ?").run(
      parsedHash.data,
      parsedRunId.data,
    );
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(sqliteStoreError(error));
  }
}

/**
 * Replace a stale idempotency claim in SQLite while its run has no events.
 * @param db Database connection for the target store.
 * @param keyHash Digest associated with the key.
 * @param options Expected owner and replacement claim metadata.
 * @returns True only when the expected claim was replaced.
 */
export function takeoverSqliteIdempotencyKey(
  db: Database.Database,
  keyHash: IdempotencyKeyHash,
  options: IdempotencyKeyTakeoverOptions,
): Promise<boolean> {
  try {
    const takeover = parseIdempotencyKeyTakeover(keyHash, options);
    const result = db
      .prepare<[Id, number, string, Id, number]>(
        `UPDATE idempotency_keys
        SET run_id = ?, created_at = ?
        WHERE key_hash = ? AND run_id = ? AND created_at <= ?
        AND NOT EXISTS (SELECT 1 FROM events WHERE events.run_id = idempotency_keys.run_id)`,
      )
      .run(
        takeover.runId,
        takeover.createdAt,
        takeover.keyHash,
        takeover.expectedRunId,
        takeover.staleBefore,
      );
    return Promise.resolve(result.changes === 1);
  } catch (error) {
    return Promise.reject(sqliteStoreError(error));
  }
}
