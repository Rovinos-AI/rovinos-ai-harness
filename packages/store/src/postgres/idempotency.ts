// SPDX-License-Identifier: Apache-2.0
import type { Pool } from "pg";
import { parseIdempotencyKeyTakeover } from "../idempotency.js";
import { storeError } from "./helpers.js";
import type { IdempotencyKeyHash, IdempotencyKeyTakeoverOptions } from "../types.js";

/**
 * Replace a stale idempotency claim in Postgres while its run has no events.
 * @param pool Connection pool for the target schema.
 * @param initialize Initialize and migrate the store schema.
 * @param keyHash Digest associated with the key.
 * @param options Expected owner and replacement claim metadata.
 * @returns True only when the expected claim was replaced.
 */
export async function takeoverPostgresIdempotencyKey(
  pool: Pool,
  initialize: () => Promise<void>,
  keyHash: IdempotencyKeyHash,
  options: IdempotencyKeyTakeoverOptions,
): Promise<boolean> {
  try {
    const takeover = parseIdempotencyKeyTakeover(keyHash, options);
    await initialize();
    const result = await pool.query(
      `UPDATE idempotency_keys
      SET run_id = $3, created_at = $4
      WHERE key_hash = $1 AND run_id = $2 AND created_at <= $5
      AND NOT EXISTS (SELECT 1 FROM events WHERE events.run_id = idempotency_keys.run_id)`,
      [
        takeover.keyHash,
        takeover.expectedRunId,
        takeover.runId,
        takeover.createdAt,
        takeover.staleBefore,
      ],
    );
    return result.rowCount === 1;
  } catch (error) {
    throw storeError(error);
  }
}
