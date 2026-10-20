// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@harness/config";
import type { RunQueue, RunQueueJob } from "@harness/store";
import { describe, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { createWorkerCommand, type WorkerCommandDependencies } from "./worker.js";

const config = HarnessConfigSchema.parse({});
const job: RunQueueJob = {
  jobId: "00000000000000000000000001",
  kind: "start",
  runId: "00000000000000000000000002",
  priority: 0,
  availableAt: 0,
  attempts: 0,
  maxAttempts: 5,
  createdAt: 0,
  updatedAt: 0,
};

function fakeQueue(): RunQueue {
  return {
    enqueue: vi.fn(() => Promise.resolve(job)),
    claim: vi.fn(() => Promise.resolve([])),
    heartbeat: vi.fn(() => Promise.resolve(true)),
    complete: vi.fn(() => Promise.resolve(true)),
    fail: vi.fn(() => Promise.resolve("retry")),
    release: vi.fn(() => Promise.resolve(true)),
    getDeadLetter: vi.fn(() => Promise.resolve(undefined)),
    close: vi.fn(() => Promise.resolve()),
  };
}

function createContext() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: () => Promise.resolve(config),
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: { now: () => 100 },
  };
  return { context, stdout, stderr };
}

function dependencies(queue: RunQueue): WorkerCommandDependencies {
  return {
    openQueue: () => Promise.resolve(queue),
    createRuntime: () =>
      Promise.resolve({
        ids: { next: () => "00000000000000000000000003" },
        clock: { now: () => 100 },
        resume: vi.fn(() => Promise.resolve({ status: "completed" })),
        close: vi.fn(() => Promise.resolve()),
      }),
    processLike: {
      once: (signal, listener) => {
        if (signal === "SIGTERM") {
          listener();
        }
      },
      removeListener: vi.fn(),
    },
  };
}

describe("harness worker", () => {
  it("starts the worker and prints one JSON document", async () => {
    const { context, stdout, stderr } = createContext();
    const queue = fakeQueue();
    const deps = dependencies(queue);

    const exitCode = await main(["--json", "worker", "--concurrency", "2"], context, [
      createWorkerCommand(deps),
    ]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(stdout).toEqual(['{"status":"worker_started"}\n']);
    expect(stderr).toEqual([]);
    expect(queue.close).toHaveBeenCalledOnce();
    expect(deps.processLike?.removeListener).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid concurrency before opening runtime resources", async () => {
    const { context, stdout, stderr } = createContext();
    const openQueue = vi.fn(() => Promise.resolve(fakeQueue()));

    const exitCode = await main(["worker", "--concurrency", "0"], context, [
      createWorkerCommand({ openQueue }),
    ]);

    expect(exitCode).toBe(ExitCode.usage);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["worker_concurrency_invalid\n"]);
    expect(openQueue).not.toHaveBeenCalled();
  });

  it("closes the queue when runtime construction fails", async () => {
    const { context, stdout, stderr } = createContext();
    const queue = fakeQueue();
    const createRuntime = vi.fn(() => Promise.reject(Object.assign(new Error(), { code: "runtime_failed" })));

    const exitCode = await main(
      ["worker"],
      context,
      [createWorkerCommand({ openQueue: () => Promise.resolve(queue), createRuntime })],
    );

    expect(exitCode).toBe(ExitCode.failure);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["runtime_failed\n"]);
    expect(queue.close).toHaveBeenCalledOnce();
  });
});
