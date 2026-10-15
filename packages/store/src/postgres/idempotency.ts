// SPDX-License-Identifier: Apache-2.0
import type { Pool } from "pg";
import { Id } from "@harness/schemas";
import { InvalidEventError, StoreUnavailableError } from "../errors.js";
import { parseIdempotencyKeyTakeover } from "../idempotency.js";
import {
  IdempotencyKeyHashSchema,
  type IdempotencyKeyHash,
  type IdempotencyKeyTakeoverOptions,
} from "../types.js";
import { storeError } from "./helpers.js";

/** Shared resources and policy checks used by idempotency operations. */
export interface PostgresIdempotencyContext {
  readonly pool: Pool;
  readonly initialize: () => Promise<void>;
  readonly assertWritable: () => void;
}

/**
 * Persist or retrieve a hashed idempotency claim.
 * @param pool Connection pool for the target schema.
 * @param initialize Initialize and migrate the store schema.
 * @param assertWritable Reject writes in read-only mode.
 * @param keyHash Digest associated with the key.
 * @param runId Candidate run identifier.
 * @param createdAt Claim time in epoch milliseconds.
 * @returns Candidate run id or the id already associated with the key.
 */
export async function claimPostgresIdempotencyKey(
  context: PostgresIdempotencyContext,
  keyHash: IdempotencyKeyHash,
  runId: Id,
  createdAt: number,
): Promise<Id> {
  const parsedHash = IdempotencyKeyHashSchema.safeParse(keyHash);
  const parsedRunId = Id.safeParse(runId);
  if (!parsedHash.success || !parsedRunId.success) {
    throw new InvalidEventError([["idempotencyKey"]]);
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new InvalidEventError([["createdAt"]]);
  }
  context.assertWritable();
  try {
    await context.initialize();
    const result = await context.pool.query<{ run_id: string }>(
      `INSERT INTO idempotency_keys (key_hash, run_id, created_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key_hash) DO UPDATE SET run_id = idempotency_keys.run_id
      RETURNING run_id`,
      [parsedHash.data, parsedRunId.data, createdAt],
    );
    const storedRunId = result.rows[0]?.run_id;
    if (storedRunId === undefined) {
      throw new StoreUnavailableError();
    }
    return Id.parse(storedRunId);
  } catch (error) {
    throw storeError(error);
  }
}

/**
 * Release an idempotency claim only while the supplied run id owns it.
 * @param pool Connection pool for the target schema.
 * @param initialize Initialize and migrate the store schema.
 * @param assertWritable Reject writes in read-only mode.
 * @param keyHash Digest associated with the key.
 * @param runId Run id expected to own the claim.
 */
export async function releasePostgresIdempotencyKey(
  context: PostgresIdempotencyContext,
  keyHash: IdempotencyKeyHash,
  runId: Id,
): Promise<void> {
  const parsedHash = IdempotencyKeyHashSchema.safeParse(keyHash);
  const parsedRunId = Id.safeParse(runId);
  if (!parsedHash.success || !parsedRunId.success) {
    throw new InvalidEventError([["idempotencyKey"]]);
  }
  context.assertWritable();
  try {
    await context.initialize();
    await context.pool.query("DELETE FROM idempotency_keys WHERE key_hash = $1 AND run_id = $2", [
      parsedHash.data,
      parsedRunId.data,
    ]);
  } catch (error) {
    throw storeError(error);
  }
}

/**
 * Replace a stale idempotency claim in Postgres while its run has no events.
 * @param pool Connection pool for the target schema.
 * @param initialize Initialize and migrate the store schema.
 * @param keyHash Digest associated with the key.
 * @param options Expected owner and replacement claim metadata.
 * @returns True only when the expected claim was replaced.
 */
export async function takeoverPostgresIdempotencyKey(
  context: PostgresIdempotencyContext,
  keyHash: IdempotencyKeyHash,
  options: IdempotencyKeyTakeoverOptions,
): Promise<boolean> {
  const takeover = parseIdempotencyKeyTakeover(keyHash, options);
  context.assertWritable();
  try {
    await context.initialize();
    const result = await context.pool.query(
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
