// SPDX-License-Identifier: Apache-2.0
import { Readable } from "node:stream";
import { Id } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function runner(
  options: {
    healthy?: boolean;
    busy?: boolean;
    healthError?: Error;
  } = {},
): RunnerPoolRunner {
  return {
    healthCheck: vi.fn(() =>
      options.healthError === undefined
        ? Promise.resolve(options.healthy ?? true)
        : Promise.reject(options.healthError),
    ),
    acquireLease: vi.fn(() =>
      options.busy ? Promise.reject(new RemoteSandboxError("sandbox_busy")) : Promise.resolve(),
    ),
    releaseLease: vi.fn(() => Promise.resolve()),
    exec: vi.fn(() => Promise.resolve(execResult)),
    fetch: vi.fn(() => Promise.resolve(fetchResult)),
    fileOperation: vi.fn(() => Promise.resolve({ entries: [], truncated: false })),
    createArchive: vi.fn(() => Promise.resolve(Readable.from([]))),
    restoreArchive: vi.fn(() => Promise.resolve()),
    hasWorkspace: vi.fn(() => Promise.resolve(true)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RunnerPool", () => {
  it("tries runners in randomized order, skips busy runners, and routes a run to its lease", async () => {
    const busyRunner = runner({ busy: true });
    const availableRunner = runner();
    const pool = new RunnerPool({
      runners: [busyRunner, availableRunner],
      random: () => 0.9,
    });

    await pool.acquireLease(runId, 30_000);
    await pool.exec(runId, spec, new AbortController().signal);
    await pool.fetch(runId, { url: "https://example.com/" }, new AbortController().signal);
    await pool.fileOperation(runId, "list", {}, new AbortController().signal);
    await pool.createArchive(runId, 1024, 2048);
    await pool.restoreArchive(runId, Readable.from([]), 1024, 2048);
    await expect(pool.hasWorkspace(runId)).resolves.toBe(true);

    expect(busyRunner.acquireLease).toHaveBeenCalledExactlyOnceWith(runId, 30_000);
    expect(availableRunner.acquireLease).toHaveBeenCalledExactlyOnceWith(runId, 30_000);
    expect(availableRunner.exec).toHaveBeenCalledExactlyOnceWith(
      runId,
      spec,
      expect.any(AbortSignal),
    );
    expect(availableRunner.fetch).toHaveBeenCalledOnce();
    expect(availableRunner.fileOperation).toHaveBeenCalledOnce();
    expect(availableRunner.createArchive).toHaveBeenCalledOnce();
    expect(availableRunner.restoreArchive).toHaveBeenCalledOnce();
    expect(availableRunner.hasWorkspace).toHaveBeenCalledTimes(2);

    await pool.releaseLease(runId);
    expect(availableRunner.releaseLease).toHaveBeenCalledExactlyOnceWith(runId);
    await expect(pool.exec(runId, spec, new AbortController().signal)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });

  it("temporarily evicts an unhealthy runner and retries its health check after cooldown", async () => {
    let now = 100;
    const unhealthy = runner({ healthy: false });
    const healthy = runner();
    const pool = new RunnerPool({
      runners: [unhealthy, healthy],
      now: () => now,
      random: () => 0.9,
      healthCooldownMs: 5,
    });

    await pool.acquireLease(runId);
    await pool.releaseLease(runId);
    now = 104;
    await pool.acquireLease(secondRunId);
    expect(unhealthy.healthCheck).toHaveBeenCalledOnce();
    await pool.releaseLease(secondRunId);

    now = 105;
    await pool.acquireLease(runId);
    expect(unhealthy.healthCheck).toHaveBeenCalledTimes(2);
  });

  it("temporarily evicts a runner when its health check throws", async () => {
    let now = 100;
    const unavailable = runner({ healthError: new Error("health check failed") });
    const healthy = runner();
    const pool = new RunnerPool({
      runners: [unavailable, healthy],
      now: () => now,
      random: () => 0.9,
      healthCooldownMs: 5,
    });

    await pool.acquireLease(runId);
    await pool.releaseLease(runId);
    now = 104;
    await pool.acquireLease(secondRunId);
    expect(unavailable.healthCheck).toHaveBeenCalledOnce();
    await pool.releaseLease(secondRunId);
    now = 105;
    await pool.acquireLease(runId);
    expect(unavailable.healthCheck).toHaveBeenCalledTimes(2);
  });

  it("returns busy when every healthy runner is occupied and unavailable when all fail health", async () => {
    const busy = runner({ busy: true });
    const pool = new RunnerPool({ runners: [busy], random: () => 0 });
    await expect(pool.acquireLease(runId)).rejects.toMatchObject({ code: "sandbox_busy" });

    const down = runner({ healthy: false });
    await expect(new RunnerPool({ runners: [down] }).acquireLease(runId)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });

  it("reports a newly leased runner's workspace as missing until its snapshot is restored", async () => {
    const runnerWithoutWorkspace = runner();
    let workspaceExists = false;
    vi.mocked(runnerWithoutWorkspace.hasWorkspace).mockImplementation(() =>
      Promise.resolve(workspaceExists),
    );
    vi.mocked(runnerWithoutWorkspace.restoreArchive).mockImplementation(() => {
      workspaceExists = true;
      return Promise.resolve();
    });
    const pool = new RunnerPool({ runners: [runnerWithoutWorkspace] });

    await pool.acquireLease(runId);
    await expect(pool.hasWorkspace(runId)).resolves.toBe(false);
    await pool.restoreArchive(runId, Readable.from([]), 1024, 2048);
    await expect(pool.hasWorkspace(runId)).resolves.toBe(true);
    await pool.releaseLease(runId);
  });

  it("restores a suspended run's snapshot when resume selects another runner", async () => {
    let firstWorkspace = true;
    let secondWorkspace = false;
    let restoredContents = "";
    let random = 0.9;
    const first = runner();
    const second = runner();
    vi.mocked(first.hasWorkspace).mockImplementation(() => Promise.resolve(firstWorkspace));
    vi.mocked(first.createArchive).mockImplementation(() =>
      Promise.resolve(Readable.from([Buffer.from("synthetic workspace contents")])),
    );
    vi.mocked(second.hasWorkspace).mockImplementation(() => Promise.resolve(secondWorkspace));
    vi.mocked(second.restoreArchive).mockImplementation(async (_id, archive) => {
      for await (const chunk of archive) {
        restoredContents += chunk.toString();
      }
      secondWorkspace = true;
    });
    vi.mocked(second.exec).mockImplementation(() =>
      Promise.resolve({ ...execResult, stdout: restoredContents }),
    );
    const pool = new RunnerPool({ runners: [first, second], random: () => random });

    await pool.acquireLease(runId);
    const snapshot = await pool.createArchive(runId, 1024, 2048);
    await pool.releaseLease(runId);
    firstWorkspace = false;
    random = 0;

    await pool.acquireLease(runId);
    await expect(pool.hasWorkspace(runId)).resolves.toBe(false);
    await pool.restoreArchive(runId, snapshot, 1024, 2048);
    await expect(pool.exec(runId, spec, new AbortController().signal)).resolves.toMatchObject({
      stdout: "synthetic workspace contents",
    });
    await pool.releaseLease(runId);
  });

  it("releases runner leases when the pool closes and safely ignores an unleased run", async () => {
    const assigned = runner();
    const pool = new RunnerPool({ runners: [assigned] });

    await pool.releaseLease(runId);
    await pool.acquireLease(runId);
    await pool.close();

    expect(assigned.releaseLease).toHaveBeenCalledExactlyOnceWith(runId);
    await pool.close();
  });

  it("rejects an empty pool and an invalid health cooldown", () => {
    expect(() => new RunnerPool({ runners: [] })).toThrow(RemoteSandboxError);
    expect(() => new RunnerPool({ runners: [runner()], healthCooldownMs: 0 })).toThrow(
      RemoteSandboxError,
    );
  });
});
