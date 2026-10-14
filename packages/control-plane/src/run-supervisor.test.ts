// SPDX-License-Identifier: Apache-2.0
import { Id } from "@harness/schemas";
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
    const finish = new Map<string, () => void>();
    const register = vi.fn();
    const supervisor = new RunSupervisor({
      maxConcurrentRuns: 2,
      activeRuns: { register },
      resumeRun: (runId, signal) =>
        new Promise<void>((resolve) => {
          signals.set(runId, signal);
          finish.set(runId, resolve);
        }),
    });

    expect(supervisor.start(firstRunId)).toEqual({ started: true });
    await vi.waitFor(() => expect(signals.has(firstRunId)).toBe(true));
    expect(supervisor.start(firstRunId)).toEqual({
      started: false,
      code: "resume_conflict",
    });
    expect(supervisor.start(secondRunId)).toEqual({ started: true });
    await vi.waitFor(() => expect(signals.has(secondRunId)).toBe(true));
    expect(supervisor.start(thirdRunId)).toEqual({
      started: false,
      code: "capacity_exceeded",
    });
    expect(register.mock.calls.map(([runId]) => runId)).toEqual([firstRunId, secondRunId]);
    expect(supervisor.isActive(firstRunId)).toBe(true);
    expect(supervisor.abort(firstRunId)).toBe(true);
    expect(signals.get(firstRunId)?.aborted).toBe(true);
    expect(supervisor.abort(thirdRunId)).toBe(false);

    finish.get(firstRunId)?.();
    await vi.waitFor(() => expect(supervisor.isActive(firstRunId)).toBe(false));
    expect(supervisor.start(thirdRunId)).toEqual({ started: true });
    finish.get(secondRunId)?.();
    finish.get(thirdRunId)?.();
  });

  it("fails closed without resume operations and releases failed work", async () => {
    const runId = Id.parse("00000000000000000000000001");
    const unavailable = new RunSupervisor({});
    expect(unavailable.start(runId)).toEqual({
      started: false,
      code: "control_plane_runtime_unavailable",
    });

    const failed = new RunSupervisor({
      resumeRun: () => Promise.reject(new Error("synthetic failure")),
    });
    expect(failed.start(runId)).toEqual({ started: true });
    await vi.waitFor(() => expect(failed.isActive(runId)).toBe(false));
  });

  it("rejects invalid concurrency limits", () => {
    expect(() => new RunSupervisor({ maxConcurrentRuns: 0 })).toThrow();
  });
});
