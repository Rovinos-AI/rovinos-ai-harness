// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { Id } from "@harness/schemas";
import { sqliteStoreError } from "./outbox.js";
import { parseIdempotencyKeyTakeover } from "../idempotency.js";
import type { IdempotencyKeyHash, IdempotencyKeyTakeoverOptions } from "../types.js";

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
