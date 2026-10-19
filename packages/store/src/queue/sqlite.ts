// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { z } from "zod";
import { migrate } from "../migrate.js";
import { systemClock, type Clock } from "../types.js";
import { sqliteStoreError } from "../sqlite/outbox.js";
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
  type RunQueueIdGenerator,
  type RunQueueJob,
  type RunQueueOptions,
  type RunQueueFailResult,
} from "./types.js";

interface QueueRow {
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
  created_at: number;
  updated_at: number;
}

interface DeadLetterRow {
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

const durationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const limitSchema = z.number().int().min(1).max(1000);
const identifierPairSchema = z
  .object({ jobId: QueueJobIdSchema, workerId: WorkerIdSchema })
  .strict();

function sqliteOperation<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(sqliteStoreError(error));
  }
}

function queueJob(row: QueueRow): RunQueueJob {
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

function retryTimestamp(now: number, retryAfterMs: number, attempts: number): number {
  const exponential = Math.min(
    Number.MAX_SAFE_INTEGER - now,
    retryAfterMs * 2 ** Math.min(attempts - 1, 52),
  );
  return now + Math.max(0, Math.trunc(exponential));
}

/** Durable SQLite run queue using an immediate transaction for exclusive claims. */
export class SqliteRunQueue implements RunQueue {
  private readonly db: Database.Database;
  private readonly maxAttempts: number;
  private readonly enqueueStatement: Database.Statement<
    [string, string, string, number, number, number, string | null, number, number]
  >;
  private readonly findDuplicateStatement: Database.Statement<
    [string, string | null, string | null],
    QueueRow
  >;
  private readonly selectClaimableStatement: Database.Statement<[number, number, number], QueueRow>;
  private readonly leaseStatement: Database.Statement<[string, number, number, string]>;
  private readonly deadLetterStatement: Database.Statement<[string, number, number]>;
  private readonly findDeadLetterStatement: Database.Statement<[string], DeadLetterRow>;
  private readonly clock: Clock;
  private readonly ids: RunQueueIdGenerator;

  /**
   * Open and migrate the queue database.
   * @param path Database file path or `:memory:`.
   * @param options Default maximum attempts for jobs.
   * @param clock Clock used for queue timestamps.
   * @param ids ULID generator for job identifiers.
   */
  constructor(
    path: string,
    options: RunQueueOptions = {},
    clock: Clock = systemClock,
    ids: RunQueueIdGenerator = new SystemRunQueueIdGenerator(clock),
  ) {
    this.maxAttempts = parseQueueInput(RunQueueOptionsSchema, options).maxAttempts;
    this.clock = clock;
    this.ids = ids;
    this.db = new Database(path);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("foreign_keys = ON");
      migrate(this.db, "sqlite", { appliedAt: this.now() });
      this.enqueueStatement = this.db.prepare<
        [string, string, string, number, number, number, string | null, number, number]
      >(
        "INSERT INTO run_queue (job_id, kind, run_id, priority, available_at, attempts, max_attempts, lease_owner, lease_expires_at, idempotency_key, last_error_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, NULL, ?, ?) ON CONFLICT DO NOTHING",
      );
      this.findDuplicateStatement = this.db.prepare<
        [string, string | null, string | null],
        QueueRow
      >(
        "SELECT * FROM run_queue WHERE run_id = ? OR (? IS NOT NULL AND idempotency_key = ?) ORDER BY created_at, job_id LIMIT 1",
      );
      this.selectClaimableStatement = this.db.prepare<[number, number, number], QueueRow>(
        "SELECT * FROM run_queue WHERE available_at <= ? AND attempts < max_attempts AND (lease_owner IS NULL OR lease_expires_at <= ?) ORDER BY priority DESC, available_at, created_at, job_id LIMIT ?",
      );
      this.leaseStatement = this.db.prepare<[string, number, number, string]>(
        "UPDATE run_queue SET lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE job_id = ?",
      );
      this.deadLetterStatement = this.db.prepare<[string, number, number]>(
        "INSERT INTO run_queue_dead (job_id, kind, run_id, priority, attempts, max_attempts, idempotency_key, last_error_code, created_at, dead_at) SELECT job_id, kind, run_id, priority, attempts, max_attempts, idempotency_key, COALESCE(last_error_code, ?), created_at, ? FROM run_queue WHERE attempts >= max_attempts AND lease_expires_at <= ?",
      );
      this.findDeadLetterStatement = this.db.prepare<[string], DeadLetterRow>(
        "SELECT job_id, kind, run_id, attempts, max_attempts, idempotency_key, last_error_code, created_at, dead_at FROM run_queue_dead WHERE job_id = ?",
      );
    } catch (error) {
      this.db.close();
      throw sqliteStoreError(error);
    }
  }

  private now(): number {
    return z.number().int().nonnegative().parse(this.clock.now());
  }

  /** {@inheritDoc RunQueue.enqueue} */
  enqueue(input: Parameters<RunQueue["enqueue"]>[0]): Promise<RunQueueJob> {
    return sqliteOperation(() => {
      const job = parseQueueInput(EnqueueRunJobSchema, input);
      const now = this.now();
      const idempotencyKey = hashIdempotencyKey(job.idempotencyKey) ?? null;
      this.enqueueStatement.run(
        parseQueueInput(QueueJobIdSchema, this.ids.next()),
        job.kind,
        job.runId,
        job.priority,
        job.availableAt ?? now,
        job.maxAttempts ?? this.maxAttempts,
        idempotencyKey,
        now,
        now,
      );
      const row = this.findDuplicateStatement.get(job.runId, idempotencyKey, idempotencyKey);
      if (row === undefined) {
        throw new Error("Queue insert did not produce an active job");
      }
      return queueJob(row);
    });
  }

  /** {@inheritDoc RunQueue.claim} */
  claim(workerId: string, limit: number, leaseMs: number): Promise<RunQueueJob[]> {
    return sqliteOperation(() => {
      const worker = parseQueueInput(WorkerIdSchema, workerId);
      const count = parseQueueInput(limitSchema, limit);
      const duration = parseQueueInput(durationSchema, leaseMs);
      const now = this.now();
      return this.db
        .transaction(() => {
          const leaseExpiresAt = parseQueueInput(z.number().int().nonnegative(), now + duration);
          this.deadLetterStatement.run("worker.lease_expired", now, now);
          this.db
            .prepare(
              "DELETE FROM run_queue WHERE attempts >= max_attempts AND lease_expires_at <= ?",
            )
            .run(now);
          const rows = this.selectClaimableStatement.all(now, now, count);
          return rows.map((row) => {
            this.leaseStatement.run(worker, leaseExpiresAt, now, row.job_id);
            return queueJob({
              ...row,
              lease_owner: worker,
              lease_expires_at: leaseExpiresAt,
              attempts: row.attempts + 1,
              updated_at: now,
            });
          });
        })
        .immediate();
    });
  }

  /** {@inheritDoc RunQueue.heartbeat} */
  heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    return sqliteOperation(() => {
      const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, {
        jobId,
        workerId,
      });
      const duration = parseQueueInput(durationSchema, leaseMs);
      const now = this.now();
      const leaseExpiresAt = parseQueueInput(z.number().int().nonnegative(), now + duration);
      const result = this.db
        .prepare(
          "UPDATE run_queue SET lease_expires_at = MAX(lease_expires_at, ?), updated_at = ? WHERE job_id = ? AND lease_owner = ? AND lease_expires_at > ?",
        )
        .run(leaseExpiresAt, now, id, worker, now);
      return result.changes === 1;
    });
  }

  /** {@inheritDoc RunQueue.complete} */
  complete(jobId: string, workerId: string): Promise<boolean> {
    return sqliteOperation(() => {
      const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, {
        jobId,
        workerId,
      });
      const result = this.db
        .prepare(
          "DELETE FROM run_queue WHERE job_id = ? AND lease_owner = ? AND lease_expires_at > ?",
        )
        .run(id, worker, this.now());
      return result.changes === 1;
    });
  }

  /** {@inheritDoc RunQueue.fail} */
  fail(
    jobId: string,
    workerId: string,
    errorCode: string,
    retryAfterMs: number,
  ): Promise<RunQueueFailResult> {
    return sqliteOperation(() => {
      const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, {
        jobId,
        workerId,
      });
      const code = parseQueueInput(QueueErrorCodeSchema, errorCode);
      const retryDelay = parseQueueInput(z.number().int().nonnegative(), retryAfterMs);
      const now = this.now();
      return this.db
        .transaction(() => {
          const row = this.db
            .prepare<[string, string, number], QueueRow>(
              "SELECT * FROM run_queue WHERE job_id = ? AND lease_owner = ? AND lease_expires_at > ?",
            )
            .get(id, worker, now);
          if (row === undefined) {
            return "lease_lost";
          }
          if (row.attempts >= row.max_attempts) {
            this.db
              .prepare(
                "INSERT INTO run_queue_dead (job_id, kind, run_id, priority, attempts, max_attempts, idempotency_key, last_error_code, created_at, dead_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              )
              .run(
                row.job_id,
                row.kind,
                row.run_id,
                row.priority,
                row.attempts,
                row.max_attempts,
                row.idempotency_key,
                code,
                row.created_at,
                now,
              );
            this.db.prepare("DELETE FROM run_queue WHERE job_id = ?").run(id);
            return "dead";
          }
          this.db
            .prepare(
              "UPDATE run_queue SET available_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?, updated_at = ? WHERE job_id = ?",
            )
            .run(retryTimestamp(now, retryDelay, row.attempts), code, now, id);
          return "retry";
        })
        .immediate();
    });
  }

  /** {@inheritDoc RunQueue.release} */
  release(jobId: string, workerId: string): Promise<boolean> {
    return sqliteOperation(() => {
      const { jobId: id, workerId: worker } = parseQueueInput(identifierPairSchema, {
        jobId,
        workerId,
      });
      const now = this.now();
      const result = this.db
        .prepare(
          "UPDATE run_queue SET available_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND lease_owner = ? AND lease_expires_at > ?",
        )
        .run(now, now, id, worker, now);
      return result.changes === 1;
    });
  }

  /** {@inheritDoc RunQueue.getDeadLetter} */
  getDeadLetter(jobId: string): Promise<RunQueueDeadLetter | undefined> {
    return sqliteOperation(() => {
      const id = parseQueueInput(QueueJobIdSchema, jobId);
      const row = this.findDeadLetterStatement.get(id);
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
            createdAt: row.created_at,
            deadAt: row.dead_at,
          });
    });
  }

  /** {@inheritDoc RunQueue.close} */
  close(): Promise<void> {
    return sqliteOperation(() => {
      this.db.close();
    });
  }
}
