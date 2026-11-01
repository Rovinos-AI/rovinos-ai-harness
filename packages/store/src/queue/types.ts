// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { Code, HarnessError, Id, Principal, Sha256Hex } from "@rovinos/schemas";
import { z } from "zod";
import { systemClock, type Clock } from "../types.js";

/** Job operations understood by the run worker. */
export const RunQueueKindSchema = z.enum(["start", "resume", "continue"]);
/** Inferred run queue operation type. */
export type RunQueueKind = z.infer<typeof RunQueueKindSchema>;

/** Validated enqueue request. Idempotency values are hashed before persistence. */
export const EnqueueRunJobSchema = z
  .object({
    kind: RunQueueKindSchema,
    runId: Id,
    priority: z.number().int().default(0),
    availableAt: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().min(1).max(100).optional(),
    idempotencyKey: z.string().min(1).max(1024).optional(),
  })
  .strict();
/** Inferred validated enqueue request type. */
export type EnqueueRunJob = z.input<typeof EnqueueRunJobSchema>;
/** Parsed enqueue request used internally. */
export type ParsedEnqueueRunJob = z.output<typeof EnqueueRunJobSchema>;

/** Runtime schema for a persisted active queue job. */
export const RunQueueJobSchema = z
  .object({
    jobId: Id,
    kind: RunQueueKindSchema,
    runId: Id,
    priority: z.number().int(),
    availableAt: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().min(1).max(100),
    leaseOwner: Code.optional(),
    leaseExpiresAt: z.number().int().nonnegative().optional(),
    idempotencyKey: Sha256Hex.optional(),
    lastErrorCode: Code.optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
/** Metadata-only queue job. */
export type RunQueueJob = z.infer<typeof RunQueueJobSchema>;

/** Persisted quota identity used while deciding whether a run may be claimed. */
export const RunQueueRunIdentitySchema = z
  .object({
    runId: Id,
    requestedBy: Principal.optional(),
    role: Code.optional(),
  })
  .strict();
/** Inferred identity metadata for one queued run. */
export type RunQueueRunIdentity = z.infer<typeof RunQueueRunIdentitySchema>;

/** Synchronous quota admission check executed inside the atomic claim transaction. */
export type RunQueueClaimGuard = (
  identity: RunQueueRunIdentity,
  activeRuns: readonly RunQueueRunIdentity[],
  alreadyRunning: boolean,
) => boolean;

/** Optional admission check used to defer jobs that exceed configured run quotas. */
export interface RunQueueClaimOptions {
  readonly canClaim: RunQueueClaimGuard;
}

/** Result of failing a leased job. */
export const RunQueueFailResultSchema = z.enum(["retry", "dead", "lease_lost"]);
/** Inferred queue failure outcome. */
export type RunQueueFailResult = z.infer<typeof RunQueueFailResultSchema>;

/** Metadata retained for a dead-lettered job. */
export const RunQueueDeadLetterSchema = z
  .object({
    jobId: Id,
    kind: RunQueueKindSchema,
    runId: Id,
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().min(1).max(100),
    idempotencyKey: Sha256Hex.optional(),
    lastErrorCode: Code,
    createdAt: z.number().int().nonnegative(),
    deadAt: z.number().int().nonnegative(),
  })
  .strict();
/** Metadata-only dead-letter entry. */
export type RunQueueDeadLetter = z.infer<typeof RunQueueDeadLetterSchema>;

/** Input validation error that retains schema paths only. */
export class InvalidRunQueueInputError extends HarnessError {
  /** Stable queue input error code. */
  readonly code = "run_queue_input_invalid";
  /** Invalid field paths; rejected values and messages are intentionally omitted. */
  readonly paths: readonly (readonly (string | number)[])[];

  constructor(paths: readonly (readonly (string | number)[])[]) {
    super("Run queue input is invalid");
    this.paths = Object.freeze(paths.map((path) => Object.freeze([...path])));
  }
}

/** ID generator required by the durable queue. */
export interface RunQueueIdGenerator {
  /** Return a new ULID. */
  next(): string;
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** System ULID source for queue jobs. */
export class SystemRunQueueIdGenerator implements RunQueueIdGenerator {
  constructor(private readonly clock: Clock = systemClock) {}

  next(): string {
    const timestamp = BigInt(Math.max(0, Math.floor(this.clock.now())));
    const random = BigInt(`0x${randomBytes(10).toString("hex")}`);
    let value = (timestamp << 80n) | random;
    let result = "";
    for (let index = 0; index < 26; index += 1) {
      result = `${ULID_ALPHABET[Number(value & 31n)] ?? "0"}${result}`;
      value >>= 5n;
    }
    return Id.parse(result);
  }
}

/** Runtime queue defaults. */
export const RunQueueOptionsSchema = z
  .object({ maxAttempts: z.number().int().min(1).max(100).default(5) })
  .strict();
/** Inferred run queue options. */
export type RunQueueOptions = z.input<typeof RunQueueOptionsSchema>;

/** Durable database-backed queue contract. */
export interface RunQueue {
  /** Insert a job or return the matching active job, preserving wake-ups during a lease. */
  enqueue(job: EnqueueRunJob): Promise<RunQueueJob>;
  /** Atomically lease up to `limit` available jobs to one worker. */
  claim(
    workerId: string,
    limit: number,
    leaseMs: number,
    options?: RunQueueClaimOptions,
  ): Promise<RunQueueJob[]>;
  /** Extend the current, unexpired lease when it is still owned by this worker. */
  heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<boolean>;
  /** Finish a leased job, retaining it when a wake-up arrived during execution. */
  complete(jobId: string, workerId: string): Promise<boolean>;
  /** Retry with exponential backoff or move the exhausted job to dead letters. */
  fail(
    jobId: string,
    workerId: string,
    errorCode: string,
    retryAfterMs: number,
  ): Promise<RunQueueFailResult>;
  /** Return a currently leased job to the ready queue immediately. */
  release(jobId: string, workerId: string): Promise<boolean>;
  /** Read a dead-letter entry by job ID. */
  getDeadLetter(jobId: string): Promise<RunQueueDeadLetter | undefined>;
  /** Close this queue's database connection. */
  close(): Promise<void>;
}

/** Apply a plain SHA-256 hash so raw caller-provided idempotency keys are never persisted. */
export function hashIdempotencyKey(key: string | undefined): string | undefined {
  return key === undefined
    ? undefined
    : Sha256Hex.parse(createHash("sha256").update(key).digest("hex"));
}

/** Parse untrusted queue input while retaining paths, but not values or messages. */
export function parseQueueInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new InvalidRunQueueInputError(
      result.error.issues.map(({ path }) =>
        path.filter((part): part is string | number => typeof part !== "symbol"),
      ),
    );
  }
  return result.data;
}

/** Validate worker, job, duration and error-code arguments. */
export const WorkerIdSchema = Code;
/** Queue identifier schema. */
export const QueueJobIdSchema = Id;
/** Queue error code schema. */
export const QueueErrorCodeSchema = Code;
