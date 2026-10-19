// SPDX-License-Identifier: Apache-2.0
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { z } from "zod";
import { migrate } from "../migrate.js";
import { storeError } from "../postgres/helpers.js";
import { systemClock, type Clock } from "../types.js";
import {
  EnqueueRunJobSchema,
  QueueErrorCodeSchema,
  QueueJobIdSchema,
  RunQueueDeadLetterSchema,
  RunQueueJobSchema,
  RunQueueOptionsSchema,
  SystemRunQueueIdGenerator,
  WorkerIdSchema,
  hashIdempotencyKey,
  parseQueueInput,
  type RunQueue,
  type RunQueueDeadLetter,
  type RunQueueFailResult,
  type RunQueueIdGenerator,
  type RunQueueJob,
  type RunQueueOptions,
} from "./types.js";

interface QueueRow extends QueryResultRow {
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

const optionsSchema = RunQueueOptionsSchema.extend({
  poolSize: z.number().int().min(1).max(100).default(10),
  schema: z.string().regex(/^[a-z_]\w{0,62}$/i).default("public"),
}).strict();
const connectionStringSchema = z
  .url()
  .refine(
    (value) =>
      URL.canParse(value) && ["postgres:", "postgresql:"].includes(new URL(value).protocol),
  );
const durationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const limitSchema = z.number().int().min(1).max(1000);
const identifierPairSchema = z.object({ jobId: QueueJobIdSchema, workerId: WorkerIdSchema }).strict();

function numberColumn(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function queueJob(row: QueueRow): RunQueueJob {
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

function retryTimestamp(now: number, retryAfterMs: number, attempts: number): number {
  const exponential = Math.min(Number.MAX_SAFE_INTEGER - now, retryAfterMs * 2 ** Math.min(attempts - 1, 52));
  return now + Math.max(0, Math.trunc(exponential));
}

/** Durable Postgres run queue using row locks with `SKIP LOCKED` for exclusive claims. */
export class PostgresRunQueue implements RunQueue {
  private readonly pool: Pool;
  private readonly clock: Clock;
  private readonly ids: RunQueueIdGenerator;
  private readonly maxAttempts: number;
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
    options: RunQueueOptions & { poolSize?: number; schema?: string } = {},
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
    this.pool = new Pool({
      connectionString: connection.data,
      max: parsedOptions.data.poolSize,
      options: `-c search_path="${parsedOptions.data.schema}"`,
    });
    this.pool.on("error", () => undefined);
  }

  private now(): number {
    return z.number().int().nonnegative().safe().parse(this.clock.now());
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= (async () => {
      await migrate(this.pool, "postgres", { appliedAt: this.now() });
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
    const now = this.now();
    const idempotencyKey = hashIdempotencyKey(job.idempotencyKey) ?? null;
    return this.transaction(async (client) => {
      await client.query(
        "INSERT INTO run_queue (job_id, kind, run_id, priority, available_at, attempts, max_attempts, lease_owner, lease_expires_at, idempotency_key, last_error_code, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 0, $6, NULL, NULL, $7, NULL, $8, $8) ON CONFLICT DO NOTHING",
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
      const result = await client.query<QueueRow>(
        "SELECT * FROM run_queue WHERE run_id = $1 OR ($2::text IS NOT NULL AND idempotency_key = $2) ORDER BY created_at, job_id LIMIT 1",
        [job.runId, idempotencyKey],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("Queue insert did not produce an active job");
      }
      return queueJob(row);
    });
  }

  /** {@inheritDoc RunQueue.claim} */
  async claim(workerId: string, limit: number, leaseMs: number): Promise<RunQueueJob[]> {
    const worker = parseQueueInput(WorkerIdSchema, workerId);
    const count = parseQueueInput(limitSchema, limit);
    const duration = parseQueueInput(durationSchema, leaseMs);
    const now = this.now();
    return this.transaction(async (client) => {
      await client.query(
        "WITH expired AS (DELETE FROM run_queue WHERE attempts >= max_attempts AND lease_expires_at <= $1 RETURNING *) INSERT INTO run_queue_dead (job_id, kind, run_id, priority, attempts, max_attempts, idempotency_key, last_error_code, created_at, dead_at) SELECT job_id, kind, run_id, priority, attempts, max_attempts, idempotency_key, COALESCE(last_error_code, 'worker.lease_expired'), created_at, $1 FROM expired",
        [now],
      );
      const selected = await client.query<QueueRow>(
        "SELECT * FROM run_queue WHERE available_at <= $1 AND attempts < max_attempts AND (lease_owner IS NULL OR lease_expires_at <= $1) ORDER BY priority DESC, available_at, created_at, job_id LIMIT $2 FOR UPDATE SKIP LOCKED",
        [now, count],
      );
      const claimed: RunQueueJob[] = [];
      const leaseExpiresAt = parseQueueInput(
        z.number().int().nonnegative().safe(),
        now + duration,
      );
      for (const row of selected.rows) {
        const result = await client.query<QueueRow>(
          "UPDATE run_queue SET lease_owner = $1, lease_expires_at = $2, attempts = attempts + 1, updated_at = $3 WHERE job_id = $4 RETURNING *",
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
    const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, { jobId, workerId });
    const duration = parseQueueInput(durationSchema, leaseMs);
    const now = this.now();
    const leaseExpiresAt = parseQueueInput(
      z.number().int().nonnegative().safe(),
      now + duration,
    );
    return this.transaction(async (client) => {
      const result = await client.query(
        "UPDATE run_queue SET lease_expires_at = $1, updated_at = $2 WHERE job_id = $3 AND lease_owner = $4 AND lease_expires_at > $2",
        [leaseExpiresAt, now, id, worker],
      );
      return result.rowCount === 1;
    });
  }

  /** {@inheritDoc RunQueue.complete} */
  async complete(jobId: string, workerId: string): Promise<boolean> {
    const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, { jobId, workerId });
    const now = this.now();
    return this.transaction(async (client) => {
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
    const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, { jobId, workerId });
    const code = parseQueueInput(QueueErrorCodeSchema, errorCode);
    const retryDelay = parseQueueInput(z.number().int().nonnegative().safe(), retryAfterMs);
    const now = this.now();
    return this.transaction(async (client) => {
      const result = await client.query<QueueRow>(
        "SELECT * FROM run_queue WHERE job_id = $1 AND lease_owner = $2 AND lease_expires_at > $3 FOR UPDATE",
        [id, worker, now],
      );
      const row = result.rows[0];
      if (row === undefined) {
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
    const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, { jobId, workerId });
    const now = this.now();
    return this.transaction(async (client) => {
      const result = await client.query(
        "UPDATE run_queue SET available_at = $1, lease_owner = NULL, lease_expires_at = NULL, updated_at = $1 WHERE job_id = $2 AND lease_owner = $3 AND lease_expires_at > $1",
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
      const result = await this.pool.query<{
        job_id: string;
        kind: string;
        run_id: string;
        attempts: number;
        max_attempts: number;
        idempotency_key: string | null;
        last_error_code: string;
        created_at: string | number;
        dead_at: string | number;
      }>(
        "SELECT job_id, kind, run_id, attempts, max_attempts, idempotency_key, last_error_code, created_at, dead_at FROM run_queue_dead WHERE job_id = $1",
        [id],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : parseQueueInput(RunQueueDeadLetterSchema, {
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
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc RunQueue.close} */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
