// SPDX-License-Identifier: Apache-2.0
import { readFileSync, watch } from "node:fs";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Id } from "@harness/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureRunWorkspace,
  InProcessBackend,
  InProcessBackendError,
  resolveWorkspacePath,
  SandboxWorkspacePathError,
} from "./index.js";
import type { Clock, ExecSpec, InProcessLogger } from "./index.js";

const runId = Id.parse("00000000000000000000000001");
const limits = { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 };
const log = vi.fn();
const logger: InProcessLogger = { log };

let workspaceRoot: string;

function createBackend(
  options: {
    readonly allowUnsafeInProcess?: boolean;
    readonly clock?: Clock;
    readonly log?: InProcessLogger;
    readonly maxTimeoutMs?: number;
  } = {},
): InProcessBackend {
  return new InProcessBackend({
    workspaceRoot,
    logger: options.log ?? logger,
    ...(options.allowUnsafeInProcess === undefined
      ? {}
      : { allowUnsafeInProcess: options.allowUnsafeInProcess }),
    ...(options.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: options.maxTimeoutMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

function makeSpec(
  argv: string[],
  options: Partial<Pick<ExecSpec, "cwd" | "env" | "stdin" | "timeoutMs" | "limits">> = {},
): ExecSpec {
  return {
    argv,
    timeoutMs: 2000,
    limits,
    ...options,
  };
}

function processHasExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    return commandEnd >= 0 && stat[commandEnd + 2] === "Z";
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (processHasExited(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return processHasExited(pid);
}

describe("InProcessBackend", () => {
  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "sandbox-inprocess-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("echoes stdin and measures duration with the injected clock", async () => {
    const times = [100, 117];
    const clock: Clock = {
      now: () => times.shift() ?? 117,
      schedule: () => () => undefined,
    };
    const backend = createBackend({ clock });

    const result = await backend.exec(
      runId,
      makeSpec([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], {
        stdin: "hello",
      }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({ exitCode: 0, stdout: "hello", stderr: "", durationMs: 17 });
    expect(log).toHaveBeenCalledWith("sandbox_inprocess_unsafe");
    expect(log).toHaveBeenCalledWith("sandbox_inprocess_limits_unenforced");
  });

  it("returns non-zero exit codes and keeps shell punctuation as argv data", async () => {
    const backend = createBackend();
    const nonZero = await backend.exec(
      runId,
      makeSpec([
        process.execPath,
        "-e",
        'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7',
      ]),
      new AbortController().signal,
    );
    const specialArgument = await backend.exec(
      runId,
      makeSpec([
        process.execPath,
        "-e",
        "process.stdout.write(process.argv[1] ?? '')",
        "; touch nope",
      ]),
      new AbortController().signal,
    );

    expect(nonZero).toMatchObject({ exitCode: 7, stdout: "out", stderr: "err" });
    expect(specialArgument.stdout).toBe("; touch nope");
  });

  // threat: T-03
  it("does not pass parent environment variables to the child", async () => {
    vi.stubEnv("HARNESS_SYNTHETIC_PARENT_SECRET", "not-for-child");
    vi.stubEnv("PATH", "/synthetic/parent/path");
    const backend = createBackend();

    const result = await backend.exec(
      runId,
      makeSpec(
        [
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify([process.env.HARNESS_SYNTHETIC_PARENT_SECRET ?? '', process.env.PATH, process.env.HARNESS_SAFE_CHILD_VALUE]))",
        ],
        { env: { HARNESS_SAFE_CHILD_VALUE: "explicitly-allowed" } },
      ),
      new AbortController().signal,
    );

    expect(result.stdout).toBe(
      JSON.stringify([
        "",
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "explicitly-allowed",
      ]),
    );
  });

  // threat: T-10
  it("kills the process group, including a grandchild, on timeout", async () => {
    let triggerTimeout: (() => void) | undefined;
    let scheduledDelayMs: number | undefined;
    let timeoutCancelled = false;
    const clock: Clock = {
      now: () => 100,
      schedule: (callback, delayMs) => {
        triggerTimeout = callback;
        scheduledDelayMs = delayMs;
        return () => {
          timeoutCancelled = true;
        };
      },
    };
    const backend = createBackend({ clock, maxTimeoutMs: 250 });
    const grandchildScript = [
      'const { writeFileSync } = require("node:fs");',
      'writeFileSync("grandchild.ready", String(process.pid));',
      "setInterval(() => {}, 1000);",
    ].join("");
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });`,
      'writeFileSync("parent.ready", String(process.pid));',
      "setInterval(() => {}, 1000);",
    ].join("");
    const projectRoot = join(workspaceRoot, runId, "project");
    await ensureRunWorkspace(workspaceRoot, runId);
    const processesReady = new Promise<void>((resolve) => {
      const watcher = watch(projectRoot, (_event, filename) => {
        if (filename?.toString() === "grandchild.ready") {
          watcher.close();
          resolve();
        }
      });
    });

    const execution = backend.exec(
      runId,
      makeSpec([process.execPath, "-e", parentScript], { timeoutMs: 300_000 }),
      new AbortController().signal,
    );
    await processesReady;
    triggerTimeout?.();
    const result = await execution;
    const parentPidText = await readFile(join(projectRoot, "parent.ready"), "utf8");
    const grandchildPidText = await readFile(join(projectRoot, "grandchild.ready"), "utf8");
    const parentPid = Number(parentPidText);
    const grandchildPid = Number(grandchildPidText);

    expect(scheduledDelayMs).toBe(250);
    expect(timeoutCancelled).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(Number.isSafeInteger(parentPid)).toBe(true);
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    expect(await waitForProcessExit(parentPid)).toBe(true);
    expect(await waitForProcessExit(grandchildPid)).toBe(true);
  });

  // threat: T-10
  it("kills a background grandchild after the command exits normally", async () => {
    const backend = createBackend();
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "child.unref();",
      "process.stdout.write(String(child.pid));",
    ].join("");

    const result = await backend.exec(
      runId,
      makeSpec([process.execPath, "-e", parentScript]),
      new AbortController().signal,
    );
    const grandchildPid = Number(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    expect(await waitForProcessExit(grandchildPid)).toBe(true);
  });

  // threat: T-11
  it("bounds captured output and records bytes produced", async () => {
    const backend = createBackend();
    const result = await backend.exec(
      runId,
      makeSpec(
        [process.execPath, "-e", 'process.stdout.write("abcdefgh"); process.stderr.write("xyz")'],
        { limits: { ...limits, outputBytes: 5 } },
      ),
      new AbortController().signal,
    );

    expect(result.stdout + result.stderr).toHaveLength(5);
    expect(result.stdoutBytes + result.stderrBytes).toBe(11);
    expect(result.truncated).toBe(true);
  });

  it("does not return a replacement character when truncation splits UTF-8", async () => {
    const backend = createBackend();
    const result = await backend.exec(
      runId,
      makeSpec([process.execPath, "-e", 'process.stdout.write("ab€")'], {
        limits: { ...limits, outputBytes: 4 },
      }),
      new AbortController().signal,
    );

    expect(result.stdout).toBe("ab");
    expect(result.stdout).not.toContain("\uFFFD");
    expect(result.stdoutBytes).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("kills the process group when aborted", async () => {
    const backend = createBackend();
    const controller = new AbortController();
    const parentScript = "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)";
    const execution = backend.exec(
      runId,
      makeSpec([process.execPath, "-e", parentScript], { timeoutMs: 5000 }),
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const result = await execution;
    const childPid = Number(result.stdout);

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGKILL");
    expect(await waitForProcessExit(childPid)).toBe(true);
  });

  it("does not spawn a process when the signal is already aborted", async () => {
    const backend = createBackend();
    const controller = new AbortController();
    controller.abort();

    await expect(
      backend.exec(runId, makeSpec([process.execPath, "-e", "process.exit(1)"]), controller.signal),
    ).resolves.toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: false });
  });

  it("refuses production construction unless explicitly enabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    const productionLogger = { log: vi.fn() };

    expect(() => new InProcessBackend({ workspaceRoot, logger: productionLogger })).toThrow(
      InProcessBackendError,
    );
    expect(productionLogger.log).toHaveBeenCalledWith("sandbox_inprocess_unsafe");
    expect(
      () =>
        new InProcessBackend({
          workspaceRoot,
          logger: productionLogger,
          allowUnsafeInProcess: true,
        }),
    ).not.toThrow();
  });

  it("resolves workspace paths and rejects traversal, absolute paths, and symlink escapes", async () => {
    const outside = await mkdtemp(join(tmpdir(), "sandbox-outside-"));
    try {
      // On macOS the temp directory is behind a symlink (/var -> /private/var).
      await expect(resolveWorkspacePath(workspaceRoot)).resolves.toBe(
        await realpath(workspaceRoot),
      );
      await expect(resolveWorkspacePath(workspaceRoot, "../outside")).rejects.toBeInstanceOf(
        SandboxWorkspacePathError,
      );
      await expect(resolveWorkspacePath(workspaceRoot, "missing-directory")).rejects.toBeInstanceOf(
        SandboxWorkspacePathError,
      );
      await expect(resolveWorkspacePath(workspaceRoot, outside)).rejects.toBeInstanceOf(
        SandboxWorkspacePathError,
      );
      await symlink(outside, join(workspaceRoot, "escape"));
      await expect(resolveWorkspacePath(workspaceRoot, "escape")).rejects.toBeInstanceOf(
        SandboxWorkspacePathError,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects commands that cannot be started", async () => {
    const backend = createBackend();
    await expect(
      backend.exec(
        runId,
        makeSpec(["/definitely/not/a/real/executable"]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "sandbox_exec_spawn_failed" });
  });
});
