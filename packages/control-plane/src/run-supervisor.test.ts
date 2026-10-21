// SPDX-License-Identifier: Apache-2.0
import { Id } from "@harness/schemas";
import type { RunQueue, RunQueueJob } from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import { describe, expect, it, vi } from "vitest";
import { RunSupervisor } from "./run-supervisor.js";

describe("RunSupervisor", () => {
  it("limits concurrency, rejects duplicate resumes, registers runs, and aborts locally", async () => {
    const builders = createEventBuilders();
    const firstRunId = builders.nextRunId();
    const secondRunId = builders.nextRunId();
    const thirdRunId = builders.nextRunId();
    const signals = new Map<string, AbortSignal>();
    const finish = new Map<string, (result?: unknown) => void>();
    const register = vi.fn((_runId: Id) => undefined);
    const terminate = vi.fn((_runId: Id) => undefined);
    const supervisor = new RunSupervisor({
      maxConcurrentRuns: 2,
      activeRuns: { register, terminate },
      resumeRun: (runId, signal, onClaimed) =>
        new Promise<unknown>((resolve) => {
          signals.set(runId, signal);
          finish.set(runId, resolve);
          onClaimed();
        }),
    });

    await expect(supervisor.start(firstRunId)).resolves.toEqual({ started: true });
    await vi.waitFor(() => {
      expect(signals.has(firstRunId)).toBe(true);
    });
    await expect(supervisor.start(firstRunId)).resolves.toEqual({
      started: false,
      code: "resume_conflict",
    });
    await expect(supervisor.start(secondRunId)).resolves.toEqual({ started: true });
    await vi.waitFor(() => {
      expect(signals.has(secondRunId)).toBe(true);
    });
    await expect(supervisor.start(thirdRunId)).resolves.toEqual({
      started: false,
      code: "capacity_exceeded",
    });
    expect(register).toHaveBeenNthCalledWith(1, firstRunId);
    expect(register).toHaveBeenNthCalledWith(2, secondRunId);
    expect(supervisor.isActive(firstRunId)).toBe(true);
    expect(supervisor.abort(firstRunId)).toBe(true);
    expect(signals.get(firstRunId)?.aborted).toBe(true);
    expect(supervisor.abort(thirdRunId)).toBe(false);

    finish.get(firstRunId)?.({ status: "completed" });
    await vi.waitFor(() => {
      expect(supervisor.isActive(firstRunId)).toBe(false);
    });
    expect(terminate).toHaveBeenCalledWith(firstRunId);
    await expect(supervisor.start(thirdRunId)).resolves.toEqual({ started: true });
    finish.get(secondRunId)?.({ status: "suspended" });
    finish.get(thirdRunId)?.({ status: "completed" });
  });

  it("fails closed without resume operations and releases failed work", async () => {
    const runId = Id.parse("00000000000000000000000001");
    const unavailable = new RunSupervisor({});
    await expect(unavailable.start(runId)).resolves.toEqual({
      started: false,
      code: "control_plane_runtime_unavailable",
    });

    const failed = new RunSupervisor({
      resumeRun: () => Promise.reject(new Error("synthetic failure")),
    });
    await expect(failed.start(runId)).resolves.toEqual({
      started: false,
      code: "resume_failed",
    });
    await vi.waitFor(() => {
      expect(failed.isActive(runId)).toBe(false);
    });
  });

  it("returns a claim conflict before acknowledging the resume", async () => {
    const runId = Id.parse("00000000000000000000000001");
    const supervisor = new RunSupervisor({
      resumeRun: () =>
        Promise.reject(Object.assign(new Error("synthetic conflict"), { code: "resume_conflict" })),
    });

    await expect(supervisor.start(runId)).resolves.toEqual({
      started: false,
      code: "resume_conflict",
    });
  });

  it("keeps suspended resumptions registered with the sentinel", async () => {
    const runId = Id.parse("00000000000000000000000002");
    const register = vi.fn((_runId: Id) => undefined);
    const terminate = vi.fn((_runId: Id) => undefined);
    const supervisor = new RunSupervisor({
      activeRuns: { register, terminate },
      resumeRun: (_id, _signal, onClaimed) => {
        onClaimed();
        return Promise.resolve({ status: "suspended" });
      },
    });

    await expect(supervisor.start(runId)).resolves.toEqual({ started: true });
    await vi.waitFor(() => {
      expect(supervisor.isActive(runId)).toBe(false);
    });

    expect(register).toHaveBeenCalledWith(runId);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("rejects invalid concurrency limits", () => {
    expect(() => new RunSupervisor({ maxConcurrentRuns: 0 })).toThrow();
  });

  it("delegates resume requests to the durable queue when configured", async () => {
    const runId = Id.parse("00000000000000000000000003");
    const job: RunQueueJob = {
      jobId: Id.parse("00000000000000000000000004"),
      kind: "resume",
      runId,
      priority: 0,
      availableAt: 100,
      attempts: 0,
      maxAttempts: 5,
      createdAt: 100,
      updatedAt: 100,
    };
    const enqueue = vi.fn(() => Promise.resolve(job));
    const queue: RunQueue = {
      enqueue,
      claim: () => Promise.resolve([]),
      heartbeat: () => Promise.resolve(true),
      complete: () => Promise.resolve(true),
      fail: () => Promise.resolve("retry"),
      release: () => Promise.resolve(true),
      getDeadLetter: () => Promise.resolve(undefined),
      close: () => Promise.resolve(),
    };
    const resumeRun = vi.fn();
    const supervisor = new RunSupervisor({ queue, resumeRun });

    await expect(supervisor.start(runId)).resolves.toEqual({ started: true });

    expect(enqueue).toHaveBeenCalledWith({ kind: "resume", runId });
    expect(resumeRun).not.toHaveBeenCalled();
    expect(supervisor.isActive(runId)).toBe(false);
  });
});
