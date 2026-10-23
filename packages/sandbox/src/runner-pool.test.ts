// SPDX-License-Identifier: Apache-2.0
import { Readable } from "node:stream";
import { Id } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { RemoteSandboxError } from "./remote-errors.js";
import { RunnerPool } from "./runner-pool.js";
import type { RunnerPoolRunner } from "./runner-pool.js";
import type { WebFetchResult } from "./web-fetch-contracts.js";

const runId = Id.parse("00000000000000000000000001");
const secondRunId = Id.parse("00000000000000000000000002");
const spec = {
  argv: ["node", "-e", ""],
  timeoutMs: 2000,
  limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
};
const execResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  stdoutBytes: 0,
  stderrBytes: 0,
  truncated: false,
  timedOut: false,
  durationMs: 1,
};
const fetchResult: WebFetchResult = {
  url: "https://example.com/",
  status: 200,
  contentType: "text/plain",
  truncated: false,
  untrusted: true,
  text: "",
  hiddenTextDropped: 0,
};

interface RunnerCallLog {
  healthCheck: number;
  acquireLease: { runId: Id; ttlMs: number | undefined }[];
  releaseLease: Id[];
  exec: { runId: Id; spec: typeof spec; signal: AbortSignal }[];
  fetch: number;
  fileOperation: number;
  createArchive: number;
  restoreArchive: number;
  hasWorkspace: number;
}

interface RunnerControls {
  workspaceExists: boolean;
  createArchive: () => Promise<Readable>;
  restoreArchive: (archive: Readable) => Promise<void>;
  execResult: () => typeof execResult;
}

interface RunnerFixture {
  readonly backend: RunnerPoolRunner;
  readonly calls: RunnerCallLog;
  readonly controls: RunnerControls;
}

function runner(
  options: {
    healthy?: boolean;
    busy?: boolean;
    healthError?: Error;
    workspaceExists?: boolean;
  } = {},
): RunnerFixture {
  const calls: RunnerCallLog = {
    healthCheck: 0,
    acquireLease: [],
    releaseLease: [],
    exec: [],
    fetch: 0,
    fileOperation: 0,
    createArchive: 0,
    restoreArchive: 0,
    hasWorkspace: 0,
  };
  const controls: RunnerControls = {
    workspaceExists: options.workspaceExists ?? true,
    createArchive: () => Promise.resolve(Readable.from([])),
    restoreArchive: () => Promise.resolve(),
    execResult: () => execResult,
  };
  const backend: RunnerPoolRunner = {
    healthCheck: () => {
      calls.healthCheck += 1;
      return options.healthError === undefined
        ? Promise.resolve(options.healthy ?? true)
        : Promise.reject(options.healthError);
    },
    acquireLease: (requestedRunId, ttlMs) => {
      calls.acquireLease.push({ runId: requestedRunId, ttlMs });
      return options.busy === true
        ? Promise.reject(new RemoteSandboxError("sandbox_busy"))
        : Promise.resolve();
    },
    releaseLease: (requestedRunId) => {
      calls.releaseLease.push(requestedRunId);
      return Promise.resolve();
    },
    exec: (requestedRunId, requestedSpec, signal) => {
      calls.exec.push({ runId: requestedRunId, spec: requestedSpec, signal });
      return Promise.resolve(controls.execResult());
    },
    fetch: () => {
      calls.fetch += 1;
      return Promise.resolve(fetchResult);
    },
    fileOperation: () => {
      calls.fileOperation += 1;
      return Promise.resolve({ entries: [], truncated: false });
    },
    createArchive: () => {
      calls.createArchive += 1;
      return controls.createArchive();
    },
    restoreArchive: (_requestedRunId, archive) => {
      calls.restoreArchive += 1;
      return controls.restoreArchive(archive);
    },
    hasWorkspace: () => {
      calls.hasWorkspace += 1;
      return Promise.resolve(controls.workspaceExists);
    },
  };
  return { backend, calls, controls };
}

describe("RunnerPool", () => {
  it("tries runners in randomized order, skips busy runners, and routes a run to its lease", async () => {
    const busyRunner = runner({ busy: true });
    const availableRunner = runner();
    const pool = new RunnerPool({
      runners: [busyRunner.backend, availableRunner.backend],
      random: () => 0.9,
    });

    await pool.acquireLease(runId, 30_000);
    await pool.exec(runId, spec, new AbortController().signal);
    await pool.fetch(runId, { url: "https://example.com/" }, new AbortController().signal);
    await pool.fileOperation(runId, "list", {}, new AbortController().signal);
    await pool.createArchive(runId, 1024, 2048);
    await pool.restoreArchive(runId, Readable.from([]), 1024, 2048);
    await expect(pool.hasWorkspace(runId)).resolves.toBe(true);

    expect(busyRunner.calls.acquireLease).toEqual([{ runId, ttlMs: 30_000 }]);
    expect(availableRunner.calls.acquireLease).toEqual([{ runId, ttlMs: 30_000 }]);
    expect(availableRunner.calls.exec).toHaveLength(1);
    expect(availableRunner.calls.exec[0]).toMatchObject({ runId, spec });
    expect(availableRunner.calls.exec[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(availableRunner.calls.fetch).toBe(1);
    expect(availableRunner.calls.fileOperation).toBe(1);
    expect(availableRunner.calls.createArchive).toBe(1);
    expect(availableRunner.calls.restoreArchive).toBe(1);
    expect(availableRunner.calls.hasWorkspace).toBe(2);

    await pool.releaseLease(runId);
    expect(availableRunner.calls.releaseLease).toEqual([runId]);
    await expect(pool.exec(runId, spec, new AbortController().signal)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });

  it("temporarily evicts an unhealthy runner and retries its health check after cooldown", async () => {
    let now = 100;
    const unhealthy = runner({ healthy: false });
    const healthy = runner();
    const pool = new RunnerPool({
      runners: [unhealthy.backend, healthy.backend],
      now: () => now,
      random: () => 0.9,
      healthCooldownMs: 5,
    });

    await pool.acquireLease(runId);
    await pool.releaseLease(runId);
    now = 104;
    await pool.acquireLease(secondRunId);
    expect(unhealthy.calls.healthCheck).toBe(1);
    await pool.releaseLease(secondRunId);

    now = 105;
    await pool.acquireLease(runId);
    expect(unhealthy.calls.healthCheck).toBe(2);
  });

  it("temporarily evicts a runner when its health check throws", async () => {
    let now = 100;
    const unavailable = runner({ healthError: new Error("health check failed") });
    const healthy = runner();
    const pool = new RunnerPool({
      runners: [unavailable.backend, healthy.backend],
      now: () => now,
      random: () => 0.9,
      healthCooldownMs: 5,
    });

    await pool.acquireLease(runId);
    await pool.releaseLease(runId);
    now = 104;
    await pool.acquireLease(secondRunId);
    expect(unavailable.calls.healthCheck).toBe(1);
    await pool.releaseLease(secondRunId);
    now = 105;
    await pool.acquireLease(runId);
    expect(unavailable.calls.healthCheck).toBe(2);
  });

  it("returns busy when every healthy runner is occupied and unavailable when all fail health", async () => {
    const busy = runner({ busy: true });
    const pool = new RunnerPool({ runners: [busy.backend], random: () => 0 });
    await expect(pool.acquireLease(runId)).rejects.toMatchObject({ code: "sandbox_busy" });

    const down = runner({ healthy: false });
    await expect(
      new RunnerPool({ runners: [down.backend] }).acquireLease(runId),
    ).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });

  it("reports a newly leased runner's workspace as missing until its snapshot is restored", async () => {
    const runnerWithoutWorkspace = runner({ workspaceExists: false });
    runnerWithoutWorkspace.controls.restoreArchive = () => {
      runnerWithoutWorkspace.controls.workspaceExists = true;
      return Promise.resolve();
    };
    const pool = new RunnerPool({ runners: [runnerWithoutWorkspace.backend] });

    await pool.acquireLease(runId);
    await expect(pool.hasWorkspace(runId)).resolves.toBe(false);
    await pool.restoreArchive(runId, Readable.from([]), 1024, 2048);
    await expect(pool.hasWorkspace(runId)).resolves.toBe(true);
    await pool.releaseLease(runId);
  });

  it("restores a suspended run's snapshot when resume selects another runner", async () => {
    let restoredContents = "";
    let random = 0.9;
    const first = runner();
    const second = runner({ workspaceExists: false });
    first.controls.createArchive = () =>
      Promise.resolve(Readable.from([Buffer.from("synthetic workspace contents")]));
    second.controls.restoreArchive = async (archive) => {
      const decoder = new TextDecoder();
      for await (const chunk of archive) {
        if (typeof chunk === "string") {
          restoredContents += chunk;
        } else if (chunk instanceof Uint8Array) {
          restoredContents += decoder.decode(chunk, { stream: true });
        }
      }
      restoredContents += decoder.decode();
      second.controls.workspaceExists = true;
    };
    second.controls.execResult = () => ({ ...execResult, stdout: restoredContents });
    const pool = new RunnerPool({
      runners: [first.backend, second.backend],
      random: () => random,
    });

    await pool.acquireLease(runId);
    const snapshot = await pool.createArchive(runId, 1024, 2048);
    await pool.releaseLease(runId);
    first.controls.workspaceExists = false;
    random = 0;

    await pool.acquireLease(runId);
    await expect(pool.hasWorkspace(runId)).resolves.toBe(false);
    await pool.restoreArchive(runId, snapshot, 1024, 2048);
    await expect(pool.exec(runId, spec, new AbortController().signal)).resolves.toMatchObject({
      stdout: "synthetic workspace contents",
    });
    await pool.releaseLease(runId);
  });

  it("releases runner leases when the pool closes and safely ignores a run without a lease", async () => {
    const assigned = runner();
    const pool = new RunnerPool({ runners: [assigned.backend] });

    await pool.releaseLease(runId);
    await pool.acquireLease(runId);
    await pool.close();

    expect(assigned.calls.releaseLease).toEqual([runId]);
    await pool.close();
  });

  it("rejects an empty pool and an invalid health cooldown", () => {
    expect(() => new RunnerPool({ runners: [] })).toThrow(RemoteSandboxError);
    expect(() => new RunnerPool({ runners: [runner().backend], healthCooldownMs: 0 })).toThrow(
      RemoteSandboxError,
    );
  });
});
