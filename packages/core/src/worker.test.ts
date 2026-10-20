// SPDX-License-Identifier: Apache-2.0
import type { RunQueue, RunQueueJob } from "@harness/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Worker } from "./worker.js";

const RUN_ID = "00000000000000000000000001";
const JOB_ID = "00000000000000000000000002";

function job(
  kind: RunQueueJob["kind"] = "start",
  runId = RUN_ID,
  jobId = JOB_ID,
): RunQueueJob {
  return {
    jobId,
    kind,
    runId,
    priority: 0,
    availableAt: 100,
    attempts: 0,
    maxAttempts: 5,
    createdAt: 100,
    updatedAt: 100,
  };
}

class FakeQueue implements RunQueue {
  readonly pending: RunQueueJob[];
  readonly completed: string[] = [];
  readonly failed: { readonly jobId: string; readonly errorCode: string }[] = [];
  readonly released: string[] = [];
  readonly enqueued: { readonly kind: string; readonly runId: string }[] = [];
  heartbeatResult = true;
  onFail: (() => void) | undefined;

  constructor(jobs: readonly RunQueueJob[] = [job()]) {
    this.pending = [...jobs];
  }

  enqueue(input: { readonly kind: RunQueueJob["kind"]; readonly runId: string }) {
    this.enqueued.push(input);
    return Promise.resolve(job(input.kind, input.runId));
  }

  claim(workerId: string, limit: number) {
    return Promise.resolve(
      this.pending.splice(0, limit).map((item) => ({ ...item, leaseOwner: workerId })),
    );
  }

  heartbeat() {
    return Promise.resolve(this.heartbeatResult);
  }

  complete(jobId: string) {
    this.completed.push(jobId);
    return Promise.resolve(true);
  }

  fail(jobId: string, _workerId: string, errorCode: string) {
    this.failed.push({ jobId, errorCode });
    this.onFail?.();
    return Promise.resolve("retry" as const);
  }

  release(jobId: string) {
    this.released.push(jobId);
    return Promise.resolve(true);
  }

  getDeadLetter() {
    return Promise.resolve(undefined);
  }

  close() {
    return Promise.resolve();
  }
}

function fakeIds() {
  let nextId = 10;
  return {
    next: () => `${nextId++}`.padStart(26, "0"),
  };
}

const fakeClock = { now: () => 100 };

afterEach(() => {
  vi.useRealTimers();
});

describe("Worker", () => {
  it("executes and completes a queued start job", async () => {
    const queue = new FakeQueue();
    let worker: Worker | undefined;
    const execute = vi.fn(async (claimed: RunQueueJob) => {
      expect(claimed.kind).toBe("start");
      worker?.stop();
      return { status: "completed" as const };
    });
    worker = new Worker({ queue, ids: fakeIds(), clock: fakeClock, execute });

    await worker.run();

    expect(worker.workerId).toBe("w_00000000000000000000000010");
    expect(execute).toHaveBeenCalledOnce();
    expect(queue.completed).toEqual([JOB_ID]);
    expect(queue.failed).toEqual([]);
  });

  it("bounds concurrent jobs to the configured limit", async () => {
    const jobs = [
      job("start", RUN_ID, JOB_ID),
      job("resume", "00000000000000000000000003", "00000000000000000000000005"),
      job("continue", "00000000000000000000000004", "00000000000000000000000006"),
    ];
    const queue = new FakeQueue(jobs);
    let worker: Worker | undefined;
    let active = 0;
    let peak = 0;
    let completed = 0;
    let resolveStarted = (): void => undefined;
    let releaseJobs = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseJobs = resolve;
    });
    const execute = async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) {
        resolveStarted();
      }
      await gate;
      active -= 1;
      completed += 1;
      if (completed === 3) {
        worker?.stop();
      }
      return { status: "completed" as const };
    };
    worker = new Worker({
      queue,
      ids: fakeIds(),
      clock: fakeClock,
      execute,
      concurrency: 2,
      pollIntervalMs: 1,
    });
    const running = worker.run();

    await started;
    expect(peak).toBe(2);
    releaseJobs();
    await running;

    expect(peak).toBe(2);
    expect(completed).toBe(3);
  });

  it("aborts a leased run and does not complete it after heartbeat loss", async () => {
    const queue = new FakeQueue();
    queue.heartbeatResult = false;
    let worker: Worker | undefined;
    const execute = vi.fn(
      (_claimed: RunQueueJob, signal: AbortSignal) =>
        new Promise<{ status: "running" }>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              expect(signal.reason).toBe("lease_lost");
              worker?.stop();
              resolve({ status: "running" });
            },
            { once: true },
          );
        }),
    );
    worker = new Worker({
      queue,
      ids: fakeIds(),
      clock: fakeClock,
      execute,
      leaseMs: 3,
      pollIntervalMs: 1,
    });

    await worker.run();

    expect(execute).toHaveBeenCalledOnce();
    expect(queue.completed).toEqual([]);
    expect(queue.failed).toEqual([]);
  });

  it("releases a suspended run back to the queue on shutdown", async () => {
    const queue = new FakeQueue();
    let worker: Worker | undefined;
    const execute = (_claimed: RunQueueJob, signal: AbortSignal) =>
      new Promise<{ status: "suspended" }>((resolve) => {
        signal.addEventListener(
          "abort",
          () => resolve({ status: "suspended" }),
          { once: true },
        );
        worker?.stop();
      });
    worker = new Worker({ queue, ids: fakeIds(), clock: fakeClock, execute });

    await worker.run();

    expect(queue.completed).toEqual([]);
    expect(queue.released).toEqual([JOB_ID]);
    expect(queue.enqueued).toEqual([]);
  });

  it("reports only the stable error code when a job fails", async () => {
    const queue = new FakeQueue();
    let worker: Worker | undefined;
    queue.onFail = () => worker?.stop();
    const execute = async () => {
      throw Object.assign(new Error("synthetic sensitive message"), { code: "model.failed" });
    };
    worker = new Worker({ queue, ids: fakeIds(), clock: fakeClock, execute });

    await worker.run();

    expect(queue.failed).toEqual([{ jobId: JOB_ID, errorCode: "model.failed" }]);
  });

  it("rejects invalid limits and a second run loop", async () => {
    const queue = new FakeQueue();
    expect(
      () => new Worker({ queue, ids: fakeIds(), clock: fakeClock, execute: vi.fn(), concurrency: 0 }),
    ).toThrowError(expect.objectContaining({ code: "worker_options_invalid" }));
    const worker = new Worker({
      queue,
      ids: fakeIds(),
      clock: fakeClock,
      execute: async () => ({ status: "completed" }),
    });
    const running = worker.run();
    await expect(worker.run()).rejects.toMatchObject({ code: "worker_already_running" });
    worker.stop();
    await running;
  });
});
