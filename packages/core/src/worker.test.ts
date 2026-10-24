// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunQueue, RunQueueJob } from "@rovinos/store";
import { createEventBuilders } from "@rovinos/store/testing";
import { SqliteEventStore, SqliteRunQueue } from "@rovinos/store-sqlite";
import {
  FakeClock,
  Id,
  RunConfigSchema,
  SequentialIdGenerator,
  type NewEvent,
} from "@rovinos/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCompletion, ModelPort, PolicyPort, ToolPort } from "./ports.js";
import { createRuntime } from "./runtime.js";
import { Worker } from "./worker.js";

const RUN_ID = "00000000000000000000000001";
const JOB_ID = "00000000000000000000000002";
const TOOL_CALL_ID = "00000000000000000000000003";
const TOOL_ID = "worker.non_idempotent";
let workerDirectory: string | undefined;

function job(kind: RunQueueJob["kind"] = "start", runId = RUN_ID, jobId = JOB_ID): RunQueueJob {
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
  heartbeatCalls = 0;
  heartbeatResponse: Promise<boolean> | undefined;
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
    this.heartbeatCalls += 1;
    return this.heartbeatResponse ?? Promise.resolve(this.heartbeatResult);
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
    next: () => String(nextId++).padStart(26, "0"),
  };
}

const fakeClock = { now: () => 100 };

afterEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  if (workerDirectory !== undefined) {
    await rm(workerDirectory, { recursive: true, force: true });
    workerDirectory = undefined;
  }
});

describe("Worker", () => {
  it("executes and completes a queued start job", async () => {
    const queue = new FakeQueue();
    const control: { worker?: Worker } = {};
    const execute = vi.fn((claimed: RunQueueJob) => {
      expect(claimed.kind).toBe("start");
      control.worker?.stop();
      return Promise.resolve({ status: "completed" as const });
    });
    const worker = new Worker({ queue, ids: fakeIds(), clock: fakeClock, execute });
    control.worker = worker;

    await worker.run();

    expect(worker.workerId).toBe("w_00000000000000000000000010");
    expect(execute).toHaveBeenCalledOnce();
    expect(queue.completed).toEqual([JOB_ID]);
    expect(queue.failed).toEqual([]);
  });

  it("normalizes uppercase ULID worker identifiers", () => {
    const worker = new Worker({
      queue: new FakeQueue([]),
      ids: { next: () => "01J8M3Q7F4K2V6D9H5P0X1B8CZ" },
      clock: fakeClock,
      execute: vi.fn(),
    });

    expect(worker.workerId).toBe("w_01j8m3q7f4k2v6d9h5p0x1b8cz");
  });

  it("bounds concurrent jobs to the configured limit", async () => {
    const jobs = [
      job("start", RUN_ID, JOB_ID),
      job("resume", "00000000000000000000000003", "00000000000000000000000005"),
      job("continue", "00000000000000000000000004", "00000000000000000000000006"),
    ];
    const queue = new FakeQueue(jobs);
    const control: { worker?: Worker } = {};
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
        control.worker?.stop();
      }
      return { status: "completed" as const };
    };
    const worker = new Worker({
      queue,
      ids: fakeIds(),
      clock: fakeClock,
      execute,
      concurrency: 2,
      pollIntervalMs: 1,
    });
    control.worker = worker;
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
    const control: { worker?: Worker } = {};
    const execute = vi.fn(
      (_claimed: RunQueueJob, signal: AbortSignal) =>
        new Promise<{ status: "running" }>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              expect(signal.reason).toBe("lease_lost");
              control.worker?.stop();
              resolve({ status: "running" });
            },
            { once: true },
          );
        }),
    );
    const worker = new Worker({
      queue,
      ids: fakeIds(),
      clock: fakeClock,
      execute,
      leaseMs: 3,
      pollIntervalMs: 1,
    });
    control.worker = worker;

    await worker.run();

    expect(execute).toHaveBeenCalledOnce();
    expect(queue.completed).toEqual([]);
    expect(queue.failed).toEqual([]);
  });

  it("reclaims an expired lease without repeating a dangling non-idempotent tool", async () => {
    vi.useFakeTimers();
    workerDirectory = await mkdtemp(join(tmpdir(), "harness-worker-reclaim-"));
    const databasePath = join(workerDirectory, "harness.db");
    const clock = new FakeClock(100);
    const queueIds = new SequentialIdGenerator();
    const firstQueue = new SqliteRunQueue(databasePath, {}, clock, queueIds);
    const secondQueue = new SqliteRunQueue(databasePath, {}, clock, queueIds);
    const runId = Id.parse(RUN_ID);
    const firstStore = new SqliteEventStore(databasePath);
    const builders = createEventBuilders();
    const seedEvents: NewEvent[] = [
      builders.runCreated(runId),
      {
        runId,
        ts: 2,
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: runId,
        type: "run_input",
        input: "synthetic worker goal",
        inputKind: "initial",
      },
    ];
    await firstStore.append(runId, seedEvents, 0);
    await firstQueue.enqueue({ kind: "start", runId });

    let sideEffects = 0;
    let markToolStarted: (() => void) | undefined;
    let markToolAborted: (() => void) | undefined;
    let resolveLateTool:
      ((result: { outcome: "ok"; result: { sideEffect: boolean } }) => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const toolAborted = new Promise<void>((resolve) => {
      markToolAborted = resolve;
    });
    const completion: ModelCompletion = {
      parts: [
        {
          type: "tool_call",
          callId: Id.parse(TOOL_CALL_ID),
          toolId: TOOL_ID,
          args: {},
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "tool_calls",
      provider: "test",
      model: "test",
      latencyMs: 0,
      schemaValid: true,
      repairAttempts: 0,
      fallbackDepth: 0,
      providerBlobs: null,
    };
    const model: ModelPort = { complete: () => Promise.resolve(completion) };
    const policy: PolicyPort = {
      version: "worker.test",
      decide: () => ({
        decision: "allow",
        ruleId: "worker_test",
        reason: "worker_test",
        editable: [],
      }),
    };
    const tool: ToolPort = {
      describe: () => ({ idempotent: false, timeoutMs: 1_000, longRunning: true }),
      prepare: (call) => Promise.resolve(call),
      execute: (_call, context) => {
        sideEffects += 1;
        markToolStarted?.();
        context.signal.addEventListener("abort", () => markToolAborted?.(), { once: true });
        return new Promise<{ outcome: "ok"; result: { sideEffect: boolean } }>((resolve) => {
          resolveLateTool = resolve;
        });
      },
    };
    const runtimeConfig = { run: RunConfigSchema.parse({}) };
    const firstRuntime = await createRuntime(runtimeConfig, {
      store: firstStore,
      queue: firstQueue,
      clock,
      ids: new SequentialIdGenerator(),
      model,
      policy,
      tool,
      transientVault: true,
    });
    const secondRuntime = await createRuntime(runtimeConfig, {
      store: new SqliteEventStore(databasePath),
      queue: secondQueue,
      clock,
      ids: new SequentialIdGenerator(),
      model,
      policy,
      tool,
      transientVault: true,
    });

    let markFirstExecutionSettled: (() => void) | undefined;
    const firstExecutionSettled = new Promise<void>((resolve) => {
      markFirstExecutionSettled = resolve;
    });
    const firstWorker = new Worker({
      queue: firstQueue,
      ids: firstRuntime.ids,
      clock,
      leaseMs: 30,
      pollIntervalMs: 1,
      execute: async (claimedJob, signal) => {
        try {
          return await firstRuntime.resume(claimedJob.runId, { signal });
        } finally {
          markFirstExecutionSettled?.();
        }
      },
    });
    const firstRunning = firstWorker.run();

    const replacementControl: { worker?: Worker } = {};
    const replacementQueue: RunQueue = {
      enqueue: (input) => secondQueue.enqueue(input),
      claim: (workerId, limit, leaseMs) => secondQueue.claim(workerId, limit, leaseMs),
      heartbeat: (jobId, workerId, leaseMs) => secondQueue.heartbeat(jobId, workerId, leaseMs),
      complete: async (jobId, workerId) => {
        const completed = await secondQueue.complete(jobId, workerId);
        replacementControl.worker?.stop();
        return completed;
      },
      fail: (jobId, workerId, errorCode, retryAfterMs) =>
        secondQueue.fail(jobId, workerId, errorCode, retryAfterMs),
      release: (jobId, workerId) => secondQueue.release(jobId, workerId),
      getDeadLetter: (jobId) => secondQueue.getDeadLetter(jobId),
      close: () => secondQueue.close(),
    };
    let replacementStatus: string | undefined;
    const secondWorker = new Worker({
      queue: replacementQueue,
      ids: secondRuntime.ids,
      clock,
      leaseMs: 30,
      pollIntervalMs: 1,
      execute: async (claimedJob, signal) => {
        const result = await secondRuntime.resume(claimedJob.runId, { signal });
        replacementStatus = result.status;
        return result;
      },
    });
    replacementControl.worker = secondWorker;

    try {
      await toolStarted;
      clock.advance(30);
      await vi.advanceTimersByTimeAsync(10);
      await toolAborted;
      firstWorker.stop();

      const danglingEvents: string[] = [];
      for await (const event of firstRuntime.store.read(runId)) {
        danglingEvents.push(event.type);
      }
      expect(danglingEvents).toContain("tool_intent");
      expect(danglingEvents).toContain("tool_execution_started");
      expect(danglingEvents).not.toContain("tool_result");
      expect(sideEffects).toBe(1);

      clock.advance(30_000);
      await secondWorker.run();
      expect(replacementStatus).toBe("suspended");
      expect(await secondQueue.claim("worker.observer", 1, 30)).toEqual([]);
      const eventsAfterReplacement: string[] = [];
      for await (const event of secondRuntime.store.read(runId)) {
        eventsAfterReplacement.push(event.type);
      }

      resolveLateTool?.({ outcome: "ok", result: { sideEffect: true } });
      await firstExecutionSettled;
      await firstRunning;

      const finalEvents: string[] = [];
      for await (const event of secondRuntime.store.read(runId)) {
        finalEvents.push(event.type);
      }
      expect(finalEvents).toEqual(eventsAfterReplacement);
      expect(finalEvents.filter((type) => type === "tool_result")).toHaveLength(0);
      expect(sideEffects).toBe(1);
    } finally {
      firstWorker.stop();
      secondWorker.stop();
      resolveLateTool?.({ outcome: "ok", result: { sideEffect: true } });
      await firstRunning;
      await Promise.all([firstRuntime.close(), secondRuntime.close()]);
      await Promise.all([firstQueue.close(), secondQueue.close()]);
    }
  });

  it("releases a suspended run back to the queue on shutdown", async () => {
    const queue = new FakeQueue();
    const control: { worker?: Worker } = {};
    const execute = (_claimed: RunQueueJob, signal: AbortSignal) =>
      new Promise<{ status: "suspended" }>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "suspended" });
          },
          { once: true },
        );
        control.worker?.stop();
      });
    const worker = new Worker({ queue, ids: fakeIds(), clock: fakeClock, execute });
    control.worker = worker;

    await worker.run();

    expect(queue.completed).toEqual([]);
    expect(queue.released).toEqual([JOB_ID]);
    expect(queue.enqueued).toEqual([]);
  });

  it("keeps renewing the lease while a run reaches its shutdown safe point", async () => {
    vi.useFakeTimers();
    const queue = new FakeQueue();
    const control: { worker?: Worker } = {};
    let finishExecution: ((result: { status: "suspended" }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const execute = (_claimed: RunQueueJob, _signal: AbortSignal) =>
      new Promise<{ status: "suspended" }>((resolve) => {
        finishExecution = resolve;
        markStarted?.();
      });
    const worker = new Worker({
      queue,
      ids: fakeIds(),
      clock: fakeClock,
      execute,
      leaseMs: 3,
      pollIntervalMs: 1,
    });
    control.worker = worker;
    const running = worker.run();

    await started;
    control.worker.stop();
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.heartbeatCalls).toBe(1);
    finishExecution?.({ status: "suspended" });
    await vi.advanceTimersByTimeAsync(1);
    await running;

    expect(queue.released).toEqual([JOB_ID]);
  });

  it("does not reschedule a heartbeat already in flight after job cleanup", async () => {
    vi.useFakeTimers();
    const queue = new FakeQueue();
    let resolveHeartbeat: ((result: boolean) => void) | undefined;
    queue.heartbeatResponse = new Promise<boolean>((resolve) => {
      resolveHeartbeat = resolve;
    });
    const control: { worker?: Worker } = {};
    let finishExecution: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const execute = () =>
      new Promise<{ status: "completed" }>((resolve) => {
        finishExecution = () => {
          control.worker?.stop();
          resolve({ status: "completed" });
        };
        markStarted?.();
      });
    const worker = new Worker({
      queue,
      ids: fakeIds(),
      clock: fakeClock,
      execute,
      leaseMs: 3,
      pollIntervalMs: 1,
    });
    control.worker = worker;
    const running = worker.run();

    await started;
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.heartbeatCalls).toBe(1);
    finishExecution?.();
    await vi.advanceTimersByTimeAsync(1);
    await running;
    resolveHeartbeat?.(true);
    await vi.advanceTimersByTimeAsync(20);

    expect(queue.heartbeatCalls).toBe(1);
  });

  it("reports only the stable error code when a job fails", async () => {
    const queue = new FakeQueue();
    const control: { worker?: Worker } = {};
    queue.onFail = () => control.worker?.stop();
    const execute = () =>
      Promise.reject(
        Object.assign(new Error("synthetic sensitive message"), { code: "model.failed" }),
      );
    const worker = new Worker({ queue, ids: fakeIds(), clock: fakeClock, execute });
    control.worker = worker;

    await worker.run();

    expect(queue.failed).toEqual([{ jobId: JOB_ID, errorCode: "model.failed" }]);
  });

  it("rejects invalid limits and a second run loop", async () => {
    const queue = new FakeQueue();
    let invalidOptionsError: unknown;
    try {
      new Worker({ queue, ids: fakeIds(), clock: fakeClock, execute: vi.fn(), concurrency: 0 });
    } catch (error: unknown) {
      invalidOptionsError = error;
    }
    expect(invalidOptionsError).toMatchObject({ code: "worker_options_invalid" });
    const worker = new Worker({
      queue,
      ids: fakeIds(),
      clock: fakeClock,
      execute: () => Promise.resolve({ status: "completed" }),
    });
    const running = worker.run();
    await expect(worker.run()).rejects.toMatchObject({ code: "worker_already_running" });
    worker.stop();
    await running;
  });
});
