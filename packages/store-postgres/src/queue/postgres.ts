// SPDX-License-Identifier: Apache-2.0
import { Pool, type PoolClient } from "pg";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  SystemRunQueueIdGenerator,
  type Clock,
  type RunQueue,
  type RunQueueDeadLetter,
  type RunQueueFailResult,
  type RunQueueIdGenerator,
  type RunQueueJob,
  type RunQueueOptions,
} from "@harness/store";
import {
  migrate,
  EnqueueRunJobSchema,
  QueueErrorCodeSchema,
  QueueJobIdSchema,
  systemClock,
  WorkerIdSchema,
  hashIdempotencyKey,
  parseQueueInput,
} from "@harness/store/adapter-internal";
import { storeError } from "../postgres/helpers.js";
import {
  connectionStringSchema,
  deadLetter,
  type DeadLetterRow,
  durationSchema,
  identifierPairSchema,
  limitSchema,
  numberColumn,
  optionsSchema,
  queueJob,
  retryTimestamp,
  type QueueRow,
} from "./postgres-helpers.js";

/** Durable Postgres run queue using row locks with `SKIP LOCKED` for exclusive claims. */
export class PostgresRunQueue implements RunQueue {
  private readonly pool: Pool;
  private readonly clock: Clock;
  private readonly ids: RunQueueIdGenerator;
  private readonly maxAttempts: number;
  private readonly readOnly: boolean;
  private initialized: Promise<void> | undefined;

  /**
   * Open a Postgres pool for the durable run queue.
   * @param connectionString Postgres connection URL.
   * @param options Pool size, schema name, and default attempt count.
   * @param clock Clock used for queue timestamps.
   * @param ids ULID generator for job identifiers.
   */
  constructor(
    connectionString: string,
    options: RunQueueOptions & {
      readonly poolSize?: number;
      readonly schema?: string;
      readonly readOnly?: boolean;
    } = {},
    clock: Clock = systemClock,
    ids: RunQueueIdGenerator = new SystemRunQueueIdGenerator(clock),
  ) {
    const connection = connectionStringSchema.safeParse(connectionString);
    const parsedOptions = optionsSchema.safeParse(options);
    if (!connection.success || !parsedOptions.success) {
      throw new TypeError("Invalid Postgres run queue configuration");
    }
    this.clock = clock;
    this.ids = ids;
    this.maxAttempts = parsedOptions.data.maxAttempts;
    this.readOnly = parsedOptions.data.readOnly;
    this.pool = new Pool({
      connectionString: connection.data,
      max: parsedOptions.data.poolSize,
      options: `-c search_path="${parsedOptions.data.schema}"`,
    });
    this.pool.on("error", () => undefined);
  }

  private now(): number {
    return z.number().int().nonnegative().parse(this.clock.now());
  }

  private ensureInitialized(): Promise<void> {
    if (this.readOnly) {
      return Promise.resolve();
    }
    this.initialized ??= (async () => {
      await migrate(this.pool, "postgres", {
        appliedAt: this.now(),
        migrationDirectory: fileURLToPath(new URL("../../migrations/postgres/", import.meta.url)),
      });
    })().catch((error: unknown) => {
      this.initialized = undefined;
      throw storeError(error);
    });
    return this.initialized;
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    const client = await this.pool.connect().catch((error: unknown) => {
      throw storeError(error);
    });
    let started = false;
    try {
      await client.query("BEGIN");
      started = true;
      const result = await operation(client);
      await client.query("COMMIT");
      started = false;
      return result;
    } catch (error) {
      if (started) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw storeError(error);
    } finally {
      client.release();
    }
  }

  /** {@inheritDoc RunQueue.enqueue} */
  async enqueue(input: Parameters<RunQueue["enqueue"]>[0]): Promise<RunQueueJob> {
    const job = parseQueueInput(EnqueueRunJobSchema, input);
    const idempotencyKey = hashIdempotencyKey(job.idempotencyKey) ?? null;
    return this.transaction(async (client) => {
      const now = this.now();
      let result: RunQueueJob | undefined;
      while (result === undefined) {
        const inserted = await client.query<QueueRow>(
          "INSERT INTO run_queue (job_id, kind, run_id, priority, available_at, attempts, max_attempts, lease_owner, lease_expires_at, idempotency_key, last_error_code, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 0, $6, NULL, NULL, $7, NULL, $8, $8) ON CONFLICT DO NOTHING RETURNING *",
          [
            parseQueueInput(QueueJobIdSchema, this.ids.next()),
            job.kind,
            job.runId,
            job.priority,
            job.availableAt ?? now,
            job.maxAttempts ?? this.maxAttempts,
            idempotencyKey,
            now,
          ],
        );
        const insertedRow = inserted.rows[0];
        if (insertedRow !== undefined) {
          result = queueJob(insertedRow);
          continue;
        }
        const duplicate = await client.query<QueueRow>(
          "SELECT * FROM run_queue WHERE run_id = $1 OR ($2::text IS NOT NULL AND idempotency_key = $2) ORDER BY created_at, job_id LIMIT 1 FOR UPDATE",
          [job.runId, idempotencyKey],
        );
        const existingRow = duplicate.rows[0];
        if (existingRow !== undefined) {
          if (
            existingRow.lease_owner !== null &&
            existingRow.lease_expires_at !== null &&
            numberColumn(existingRow.lease_expires_at) > this.now()
          ) {
            await client.query(
              "UPDATE run_queue SET wake_requested = TRUE, updated_at = $1 WHERE job_id = $2 AND lease_owner IS NOT NULL AND lease_expires_at > $1",
              [this.now(), existingRow.job_id],
            );
          }
          result = queueJob(existingRow);
        }
      }
      return result;
    });
  }

  /** {@inheritDoc RunQueue.claim} */
  async claim(workerId: string, limit: number, leaseMs: number): Promise<RunQueueJob[]> {
    const worker = parseQueueInput(WorkerIdSchema, workerId);
    const count = parseQueueInput(limitSchema, limit);
    const duration = parseQueueInput(durationSchema, leaseMs);
    return this.transaction(async (client) => {
      const expired = await client.query<QueueRow>(
        "SELECT * FROM run_queue WHERE attempts >= max_attempts AND lease_expires_at <= $1 ORDER BY lease_expires_at, job_id FOR UPDATE SKIP LOCKED",
        [this.now()],
      );
      const expiredAt = this.now();
      for (const row of expired.rows) {
        if (
          row.lease_expires_at === null ||
          numberColumn(row.lease_expires_at) > expiredAt ||
          row.attempts < row.max_attempts
        ) {
          continue;
        }
        await client.query(
          "INSERT INTO run_queue_dead (job_id, kind, run_id, priority, attempts, max_attempts, idempotency_key, last_error_code, created_at, dead_at) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'worker.lease_expired'), $9, $10)",
          [
            row.job_id,
            row.kind,
            row.run_id,
            row.priority,
            row.attempts,
            row.max_attempts,
            row.idempotency_key,
            row.last_error_code,
            numberColumn(row.created_at),
            expiredAt,
          ],
        );
        await client.query("DELETE FROM run_queue WHERE job_id = $1", [row.job_id]);
      }
      const selected = await client.query<QueueRow>(
        "SELECT * FROM run_queue WHERE available_at <= $1 AND attempts < max_attempts AND (lease_owner IS NULL OR lease_expires_at <= $1) ORDER BY priority DESC, available_at, created_at, job_id LIMIT $2 FOR UPDATE SKIP LOCKED",
        [this.now(), count],
      );
      const claimed: RunQueueJob[] = [];
      const now = this.now();
      const leaseExpiresAt = parseQueueInput(z.number().int().nonnegative(), now + duration);
      for (const row of selected.rows) {
        if (
          numberColumn(row.available_at) > now ||
          row.attempts >= row.max_attempts ||
          (row.lease_expires_at !== null && numberColumn(row.lease_expires_at) > now)
        ) {
          continue;
        }
        const result = await client.query<QueueRow>(
          "UPDATE run_queue SET lease_owner = $1, lease_expires_at = $2, attempts = attempts + 1, updated_at = $3 WHERE job_id = $4 AND available_at <= $3 AND attempts < max_attempts AND (lease_owner IS NULL OR lease_expires_at <= $3) RETURNING *",
          [worker, leaseExpiresAt, now, row.job_id],
        );
        const updated = result.rows[0];
        if (updated !== undefined) {
          claimed.push(queueJob(updated));
        }
      }
      return claimed;
    });
  }

  /** {@inheritDoc RunQueue.heartbeat} */
  async heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, {
      jobId,
      workerId,
    });
    const duration = parseQueueInput(durationSchema, leaseMs);
    return this.transaction(async (client) => {
      const selected = await client.query<QueueRow>(
        "SELECT * FROM run_queue WHERE job_id = $1 AND lease_owner = $2 FOR UPDATE",
        [id, worker],
      );
      const row = selected.rows[0];
      const now = this.now();
      if (
        row === undefined ||
        row.lease_expires_at === null ||
        numberColumn(row.lease_expires_at) <= now
      ) {
        return false;
      }
      const leaseExpiresAt = parseQueueInput(z.number().int().nonnegative(), now + duration);
      const result = await client.query(
        "UPDATE run_queue SET lease_expires_at = GREATEST(lease_expires_at, $1), updated_at = $2 WHERE job_id = $3 AND lease_owner = $4 AND lease_expires_at > $2",
        [leaseExpiresAt, now, id, worker],
      );
      return result.rowCount === 1;
    });
  }

  /** {@inheritDoc RunQueue.complete} */
  async complete(jobId: string, workerId: string): Promise<boolean> {
    const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, {
      jobId,
      workerId,
    });
    return this.transaction(async (client) => {
      const selected = await client.query<QueueRow>(
        "SELECT * FROM run_queue WHERE job_id = $1 AND lease_owner = $2 FOR UPDATE",
        [id, worker],
      );
      const row = selected.rows[0];
      const now = this.now();
      if (
        row === undefined ||
        row.lease_expires_at === null ||
        numberColumn(row.lease_expires_at) <= now
      ) {
        return false;
      }
      if (row.wake_requested) {
        const requeued = await client.query(
          "UPDATE run_queue SET available_at = $1, attempts = GREATEST(attempts - 1, 0), lease_owner = NULL, lease_expires_at = NULL, wake_requested = FALSE, updated_at = $1 WHERE job_id = $2 AND lease_owner = $3 AND lease_expires_at > $1",
          [now, id, worker],
        );
        return requeued.rowCount === 1;
      }
      const result = await client.query(
        "DELETE FROM run_queue WHERE job_id = $1 AND lease_owner = $2 AND lease_expires_at > $3",
        [id, worker, now],
      );
      return result.rowCount === 1;
    });
  }

  /** {@inheritDoc RunQueue.fail} */
  async fail(
    jobId: string,
    workerId: string,
    errorCode: string,
    retryAfterMs: number,
  ): Promise<RunQueueFailResult> {
    const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, {
      jobId,
      workerId,
    });
    const code = parseQueueInput(QueueErrorCodeSchema, errorCode);
    const retryDelay = parseQueueInput(z.number().int().nonnegative(), retryAfterMs);
    return this.transaction(async (client) => {
      const result = await client.query<QueueRow>(
        "SELECT * FROM run_queue WHERE job_id = $1 AND lease_owner = $2 FOR UPDATE",
        [id, worker],
      );
      const row = result.rows[0];
      const now = this.now();
      if (
        row === undefined ||
        row.lease_expires_at === null ||
        numberColumn(row.lease_expires_at) <= now
      ) {
        return "lease_lost";
      }
      if (row.attempts >= row.max_attempts) {
        await client.query(
          "INSERT INTO run_queue_dead (job_id, kind, run_id, priority, attempts, max_attempts, idempotency_key, last_error_code, created_at, dead_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [
            row.job_id,
            row.kind,
            row.run_id,
            row.priority,
            row.attempts,
            row.max_attempts,
            row.idempotency_key,
            code,
            numberColumn(row.created_at),
            now,
          ],
        );
        await client.query("DELETE FROM run_queue WHERE job_id = $1", [id]);
        return "dead";
      }
      await client.query(
        "UPDATE run_queue SET available_at = $1, lease_owner = NULL, lease_expires_at = NULL, last_error_code = $2, updated_at = $3 WHERE job_id = $4",
        [retryTimestamp(now, retryDelay, row.attempts), code, now, id],
      );
      return "retry";
    });
  }

  /** {@inheritDoc RunQueue.release} */
  async release(jobId: string, workerId: string): Promise<boolean> {
    const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, {
      jobId,
      workerId,
    });
    return this.transaction(async (client) => {
      const selected = await client.query<QueueRow>(
        "SELECT * FROM run_queue WHERE job_id = $1 AND lease_owner = $2 FOR UPDATE",
        [id, worker],
      );
      const row = selected.rows[0];
      const now = this.now();
      if (
        row === undefined ||
        row.lease_expires_at === null ||
        numberColumn(row.lease_expires_at) <= now
      ) {
        return false;
      }
      const result = await client.query(
        "UPDATE run_queue SET available_at = $1, attempts = GREATEST(attempts - 1, 0), lease_owner = NULL, lease_expires_at = NULL, wake_requested = FALSE, updated_at = $1 WHERE job_id = $2 AND lease_owner = $3 AND lease_expires_at > $1",
        [now, id, worker],
      );
      return result.rowCount === 1;
    });
  }

  /** {@inheritDoc RunQueue.getDeadLetter} */
  async getDeadLetter(jobId: string): Promise<RunQueueDeadLetter | undefined> {
    const id = parseQueueInput(QueueJobIdSchema, jobId);
    await this.ensureInitialized();
    try {
      const result = await this.pool.query<DeadLetterRow>(
        "SELECT job_id, kind, run_id, attempts, max_attempts, idempotency_key, last_error_code, created_at, dead_at FROM run_queue_dead WHERE job_id = $1",
        [id],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : deadLetter(row);
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc RunQueue.close} */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
