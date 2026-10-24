// SPDX-License-Identifier: Apache-2.0
import { Code, HarnessError } from "@harness/schemas";
import { type RunQueue, type RunQueueJob } from "@harness/store";
import { countWorkerJob, recordWorkerQueueLag } from "@harness/telemetry";
import { z } from "zod";
import type { IdGenerator } from "./ports.js";
import type { Clock } from "./recorder.js";
import type { RunLoopResult } from "./loop.js";
import { RESUME_LEASE_MS } from "./resume-lease.js";

const WorkerLimitsSchema = z
  .object({
    concurrency: z.number().int().min(1).max(1000),
    leaseMs: z.number().int().min(3),
    pollIntervalMs: z.number().int().positive(),
    retryAfterMs: z.number().int().nonnegative(),
  })
  .strict();

/** Outcomes emitted by one worker's job-processing loop. */
export type WorkerJobOutcome = "completed" | "suspended" | "failed" | "lease_lost";

/** Executes a claimed job and returns its resulting run status. */
export type WorkerJobExecutor = (
  job: RunQueueJob,
  signal: AbortSignal,
) => Promise<Pick<RunLoopResult, "status">>;

/** Configuration for one queue worker. */
export interface WorkerOptions {
  readonly queue: RunQueue;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly execute: WorkerJobExecutor;
  readonly concurrency?: number;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
  readonly retryAfterMs?: number;
}

class WorkerOptionsError extends HarnessError {
  readonly code = "worker_options_invalid";

  constructor() {
    super("Worker options are invalid.");
  }
}

class WorkerAlreadyRunningError extends HarnessError {
  readonly code = "worker_already_running";

  constructor() {
    super("Worker is already running.");
  }
}

function errorCode(error: unknown): Code {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "worker_job_failed";
}

function isFinished(status: RunLoopResult["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function waitForPoll(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, intervalMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Claims and executes durable run jobs while maintaining their queue leases.
 *
 * The executor receives an abort signal that is cancelled on lease loss or worker shutdown.
 * @param options - Queue, run executor, clock, IDs, and worker limits.
 */
export class Worker {
  readonly workerId: string;
  private readonly queue: RunQueue;
  private readonly clock: Clock;
  private readonly execute: WorkerJobExecutor;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly retryAfterMs: number;
  private readonly stopping = new AbortController();
  private readonly active = new Map<string, AbortController>();
  private readonly activeJobs = new Set<Promise<void>>();
  private running = false;

  constructor(options: WorkerOptions) {
    let limits: z.infer<typeof WorkerLimitsSchema>;
    try {
      limits = WorkerLimitsSchema.parse({
        concurrency: options.concurrency ?? 1,
        leaseMs: options.leaseMs ?? 30_000,
        pollIntervalMs: options.pollIntervalMs ?? 250,
        retryAfterMs: options.retryAfterMs ?? 1_000,
      });
    } catch {
      throw new WorkerOptionsError();
    }
    this.concurrency = limits.concurrency;
    this.leaseMs = limits.leaseMs;
    this.pollIntervalMs = limits.pollIntervalMs;
    this.retryAfterMs = limits.retryAfterMs;
    this.queue = options.queue;
    this.clock = options.clock;
    this.execute = options.execute;
    this.workerId = Code.parse(`w_${options.ids.next().toLowerCase()}`);
  }

  /** Stops claiming new jobs and asks active runs to suspend at a safe point. */
  stop(): void {
    if (!this.stopping.signal.aborted) {
      this.stopping.abort("shutdown");
    }
    for (const controller of this.active.values()) {
      controller.abort("shutdown");
    }
  }

  /** Runs until {@link Worker.stop} is called, then waits for active jobs to settle. */
  async run(): Promise<void> {
    if (this.running) {
      throw new WorkerAlreadyRunningError();
    }
    this.running = true;
    try {
      while (!this.stopping.signal.aborted) {
        const available = this.concurrency - this.active.size;
        if (available > 0) {
          const jobs = await this.queue.claim(this.workerId, available, this.leaseMs);
          if (this.isStopping()) {
            await Promise.all(jobs.map((job) => this.queue.release(job.jobId, this.workerId)));
            break;
          }
          for (const job of jobs) {
            this.startJob(job);
          }
        }
        await waitForPoll(this.pollIntervalMs, this.stopping.signal);
      }
    } finally {
      this.stop();
      await Promise.all(this.activeJobs);
      this.running = false;
    }
  }

  private startJob(job: RunQueueJob): void {
    const controller = new AbortController();
    this.active.set(job.jobId, controller);
    const processing = this.processJob(job, controller)
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(job.jobId);
        this.activeJobs.delete(processing);
      });
    this.activeJobs.add(processing);
  }

  private async processJob(job: RunQueueJob, controller: AbortController): Promise<void> {
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let outcome: WorkerJobOutcome = "failed";
    const stop = (): void => {
      controller.abort("shutdown");
    };
    this.stopping.signal.addEventListener("abort", stop, { once: true });
    const scheduleHeartbeat = (): void => {
      if (!done) {
        heartbeatTimer = setTimeout(() => void heartbeat(), Math.floor(this.leaseMs / 3));
      }
    };
    const heartbeat = async (): Promise<void> => {
      if (done) {
        return;
      }
      try {
        if (!(await this.queue.heartbeat(job.jobId, this.workerId, this.leaseMs))) {
          controller.abort("lease_lost");
          return;
        }
      } catch {
        controller.abort("lease_lost");
        return;
      }
      scheduleHeartbeat();
    };
    scheduleHeartbeat();
    recordWorkerQueueLag(Math.max(0, this.clock.now() - job.availableAt));

    try {
      const result = await this.execute(job, controller.signal);
      if (controller.signal.reason === "lease_lost") {
        outcome = "lease_lost";
        return;
      }
      if (controller.signal.reason === "shutdown" && result.status === "suspended") {
        outcome = (await this.queue.release(job.jobId, this.workerId)) ? "suspended" : "lease_lost";
        return;
      }
      if (!isFinished(result.status) && result.status !== "suspended") {
        throw new WorkerOptionsError();
      }
      if (!(await this.queue.complete(job.jobId, this.workerId))) {
        outcome = "lease_lost";
        return;
      }
      outcome = result.status === "suspended" ? "suspended" : "completed";
    } catch (error) {
      outcome = await this.handleJobError(job, controller, error);
    } finally {
      done = true;
      if (heartbeatTimer !== undefined) {
        clearTimeout(heartbeatTimer);
      }
      this.stopping.signal.removeEventListener("abort", stop);
      countWorkerJob(outcome);
    }
  }

  private async handleJobError(
    job: RunQueueJob,
    controller: AbortController,
    error: unknown,
  ): Promise<WorkerJobOutcome> {
    if (controller.signal.reason === "lease_lost") {
      return "lease_lost";
    }
    if (controller.signal.reason === "shutdown") {
      return (await this.queue.release(job.jobId, this.workerId)) ? "suspended" : "lease_lost";
    }
    const code = errorCode(error);
    const retryAfterMs =
      code === "resume_conflict" ? Math.max(this.retryAfterMs, RESUME_LEASE_MS) : this.retryAfterMs;
    const result = await this.queue.fail(job.jobId, this.workerId, code, retryAfterMs);
    return result === "lease_lost" ? "lease_lost" : "failed";
  }

  private isStopping(): boolean {
    return this.stopping.signal.aborted;
  }
}
