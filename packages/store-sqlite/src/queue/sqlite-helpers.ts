// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { RunQueueDeadLetter, RunQueueJob } from "@rovinos/store";
import {
  QueueJobIdSchema,
  RunQueueDeadLetterSchema,
  RunQueueJobSchema,
  RunQueueOptionsSchema,
  WorkerIdSchema,
  parseQueueInput,
} from "@rovinos/store/adapter-internal";
import { sqliteStoreError } from "../sqlite/outbox.js";

/** Raw SQLite shape for an active queue job. */
export interface QueueRow {
  job_id: string;
  kind: string;
  run_id: string;
  priority: number;
  available_at: number;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  idempotency_key: string | null;
  last_error_code: string | null;
  wake_requested: number;
  created_at: number;
  updated_at: number;
}

/** Raw SQLite shape for a dead-lettered job. */
export interface DeadLetterRow {
  job_id: string;
  kind: string;
  run_id: string;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
  last_error_code: string;
  created_at: number;
  dead_at: number;
}

/** Validates positive lease durations. */
export const durationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** Validates a worker claim batch size. */
export const limitSchema = z.number().int().min(1).max(1000);
/** Validates queue options for SQLite. */
export const SqliteQueueOptionsSchema = RunQueueOptionsSchema.extend({
  readOnly: z.boolean().default(false),
}).strict();
/** Validates the job and worker identifiers used by queue operations. */
export const identifierPairSchema = z
  .object({ jobId: QueueJobIdSchema, workerId: WorkerIdSchema })
  .strict();

/** Converts synchronous SQLite errors into the store's closed error contract. */
export function sqliteOperation<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(sqliteStoreError(error));
  }
}

/** Calculates a capped exponential retry timestamp. */
export function retryTimestamp(now: number, retryAfterMs: number, attempts: number): number {
  const exponential = Math.min(
    Number.MAX_SAFE_INTEGER - now,
    retryAfterMs * 2 ** Math.min(attempts - 1, 52),
  );
  return now + Math.max(0, Math.trunc(exponential));
}

/** Validates and maps a SQLite queue row to its public job contract. */
export function queueJob(row: QueueRow): RunQueueJob {
  return parseQueueInput(RunQueueJobSchema, {
    jobId: row.job_id,
    kind: row.kind,
    runId: row.run_id,
    priority: row.priority,
    availableAt: row.available_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Validates and maps a SQLite dead-letter row to its public contract. */
export function deadLetter(row: DeadLetterRow): RunQueueDeadLetter {
  return parseQueueInput(RunQueueDeadLetterSchema, {
    jobId: row.job_id,
    kind: row.kind,
    runId: row.run_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    deadAt: row.dead_at,
  });
}
