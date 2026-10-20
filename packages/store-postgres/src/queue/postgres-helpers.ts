// SPDX-License-Identifier: Apache-2.0
import type { QueryResultRow } from "pg";
import { z } from "zod";
import type { RunQueueDeadLetter, RunQueueJob } from "@harness/store";
import {
  RunQueueDeadLetterSchema,
  RunQueueJobSchema,
  RunQueueOptionsSchema,
  QueueJobIdSchema,
  WorkerIdSchema,
  parseQueueInput,
} from "@harness/store/adapter-internal";

/** Row shape returned by active queue queries. */
export interface QueueRow extends QueryResultRow {
  job_id: string;
  kind: string;
  run_id: string;
  priority: number;
  available_at: string | number;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | number | null;
  idempotency_key: string | null;
  last_error_code: string | null;
  created_at: string | number;
  updated_at: string | number;
}

/** Row shape returned by dead-letter queries. */
export interface DeadLetterRow extends QueryResultRow {
  job_id: string;
  kind: string;
  run_id: string;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
  last_error_code: string;
  created_at: string | number;
  dead_at: string | number;
}

/** Validated Postgres pool and schema options. */
export const optionsSchema = RunQueueOptionsSchema.extend({
  poolSize: z.number().int().min(1).max(100).default(10),
  schema: z
    .string()
    .regex(/^[a-z_]\w{0,62}$/i)
    .default("public"),
}).strict();
/** Validated Postgres connection URL. */
export const connectionStringSchema = z
  .url()
  .refine(
    (value) =>
      URL.canParse(value) && ["postgres:", "postgresql:"].includes(new URL(value).protocol),
  );
/** Validated lease and retry duration. */
export const durationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** Validated claim batch size. */
export const limitSchema = z.number().int().min(1).max(1000);
/** Validated queue job and worker identifiers. */
export const identifierPairSchema = z
  .object({ jobId: QueueJobIdSchema, workerId: WorkerIdSchema })
  .strict();

/** Convert an integer column returned in text or numeric form to a number. */
export function numberColumn(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

/** Validate and map an active Postgres row to a public queue job. */
export function queueJob(row: QueueRow): RunQueueJob {
  return parseQueueInput(RunQueueJobSchema, {
    jobId: row.job_id,
    kind: row.kind,
    runId: row.run_id,
    priority: row.priority,
    availableAt: numberColumn(row.available_at),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null
      ? {}
      : { leaseExpiresAt: numberColumn(row.lease_expires_at) }),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    createdAt: numberColumn(row.created_at),
    updatedAt: numberColumn(row.updated_at),
  });
}

/** Validate and map a Postgres dead-letter row to the public contract. */
export function deadLetter(row: DeadLetterRow): RunQueueDeadLetter {
  return parseQueueInput(RunQueueDeadLetterSchema, {
    jobId: row.job_id,
    kind: row.kind,
    runId: row.run_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    lastErrorCode: row.last_error_code,
    createdAt: numberColumn(row.created_at),
    deadAt: numberColumn(row.dead_at),
  });
}

/** Calculate a capped exponential retry timestamp. */
export function retryTimestamp(now: number, retryAfterMs: number, attempts: number): number {
  const exponential = Math.min(
    Number.MAX_SAFE_INTEGER - now,
    retryAfterMs * 2 ** Math.min(attempts - 1, 52),
  );
  return now + Math.max(0, Math.trunc(exponential));
}
