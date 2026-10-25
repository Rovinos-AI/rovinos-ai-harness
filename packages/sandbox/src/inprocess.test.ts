// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import process from "node:process";
import { Id } from "@rovinos/schemas";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
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

function readProcessStat(pid: number): string[] | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    // comm may contain spaces and parentheses; field 3 follows its final closing parenthesis.
    return commandEnd < 0
      ? undefined
      : stat
          .slice(commandEnd + 2)
          .trim()
          .split(/\s+/);
  } catch {
    return undefined;
  }
}

function readReadyProcess(pidFile: string) {
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  return { pid, startTime: readProcessStat(pid)?.[19] };
}

function processHasExited(pid: number, startTime?: string): boolean {
  const stat = readProcessStat(pid);
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  return (
    stat?.[0] === "Z" ||
    stat?.[0] === "X" ||
    (startTime !== undefined && stat?.[19] !== undefined && stat[19] !== startTime)
  );
}

function processExitDiagnostic(pid: number): string {
  try {
    const status = fs.readFileSync(`/proc/${String(pid)}/status`, "utf8");
    const state = /^State:\s+([A-Z])(?:\s|$)/m.exec(status)?.[1] ?? "unknown";
    const parentPid = /^PPid:\s+(\d+)\s*$/m.exec(status)?.[1] ?? "unknown";
    return `pid=${String(pid)} state=${state} ppid=${parentPid}`;
  } catch {
    return `pid=${String(pid)} state=unknown ppid=unknown`;
  }
}

async function waitForProcessExit(pid: number, startTime?: string): Promise<boolean> {
  // 15 s: a SIGKILLed child can take seconds to be reaped on a loaded CI agent.
  for (let attempt = 0; attempt < 1500; attempt += 1) {
    if (processHasExited(pid, startTime)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return processHasExited(pid, startTime);
}

async function expectProcessExit(pid: number, startTime?: string): Promise<void> {
  const exited = await waitForProcessExit(pid, startTime);
  assert.isTrue(exited, exited ? undefined : processExitDiagnostic(pid));
}

describe("process exit observation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mockStat(state: string, startTime = "123"): void {
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `42 (synthetic (process) name) ${[state, ...Array<string>(18).fill("0"), startTime].join(" ")}`,
    );
  }

  it.each(["", "0", "-1", "NaN", "1.5"])("refuses an invalid readiness PID %j", (pid) => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(pid);
    expect(() => readReadyProcess("synthetic.ready")).toThrow();
  });

  it("captures field 22 before a ready process can be killed", () => {
    mockStat("S");
    vi.mocked(fs.readFileSync).mockReturnValueOnce("42");
    expect(readReadyProcess("synthetic.ready")).toEqual({ pid: 42, startTime: "123" });
  });

  it.each(["Z", "X"])("recognizes state %s as exited", (state) => {
    mockStat(state);
    expect(processHasExited(42, "123")).toBe(true);
  });

  it("recognizes a reused PID even while its replacement is alive", () => {
    mockStat("S", "124");
    expect(processHasExited(42, "123")).toBe(true);
  });

  // threat: T-10
  it.each(["R", "S", "D", "T"])("does not accept a live original in state %s", (state) => {
    mockStat(state);
    expect(processHasExited(42, "123")).toBe(false);
    expect(processHasExited(42)).toBe(false);
  });

  it("recognizes a process reaped between reading stat and probing the PID", () => {
    mockStat("S");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(processHasExited(42, "123")).toBe(true);
  });

  it("keeps the PID probe fallback when proc is unavailable", () => {
    mockStat("S");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(processHasExited(42, "123")).toBe(false);
    expect(processExitDiagnostic(42)).toBe("pid=42 state=unknown ppid=unknown");
  });

  it("includes the observed state and parent PID when a wait fails", async () => {
    vi.useFakeTimers();
    mockStat("S");
    vi.mocked(fs.readFileSync).mockReturnValue("State:\tS (sleeping)\nPPid:\t17\n");
    await expect(
      Promise.all([expectProcessExit(42, "123"), vi.runAllTimersAsync()]),
    ).rejects.toThrow("pid=42 state=S ppid=17");
  });

  it("does not mistake malformed stat for a changed start time", () => {
    mockStat("S");
    for (const stat of ["invalid", "42 (synthetic) S"]) {
      vi.mocked(fs.readFileSync).mockReturnValue(stat);
      expect(processHasExited(42, "123")).toBe(false);
    }
  });

  // threat: T-03
  it("reports only state codes and numeric PIDs, never raw status contents", () => {
    mockStat("S");
    vi.mocked(fs.readFileSync).mockReturnValue(
      "Name:\tsynthetic-private-canary\nState:\tS (sleeping)\nPPid:\t17\n",
    );
    expect(processExitDiagnostic(42)).toBe("pid=42 state=S ppid=17");
    vi.mocked(fs.readFileSync).mockReturnValue(
      "State:\tsynthetic-private-canary\nPPid:\tsynthetic-private-canary\n",
    );
    expect(processExitDiagnostic(42)).toBe("pid=42 state=unknown ppid=unknown");
  });
});

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
    const execution = backend.exec(
      runId,
      makeSpec([process.execPath, "-e", parentScript], { timeoutMs: 300_000 }),
      new AbortController().signal,
    );
    // File creation notifications can precede the PID write; Number("") is the live group PID 0.
    const { parent, grandchild } = await vi.waitFor(
      () => ({
        parent: readReadyProcess(join(projectRoot, "parent.ready")),
        grandchild: readReadyProcess(join(projectRoot, "grandchild.ready")),
      }),
      { timeout: 15_000, interval: 20 },
    );
    triggerTimeout?.();
    const result = await execution;

    expect(scheduledDelayMs).toBe(250);
    expect(timeoutCancelled).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    await expectProcessExit(parent.pid, parent.startTime);
    await expectProcessExit(grandchild.pid, grandchild.startTime);
  }, 30_000);

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
    await expectProcessExit(grandchildPid);
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
    // The child announces itself through a file in its working directory, so the test aborts only
    // after the child is really running; a fixed delay raced slow child starts on a busy agent.
    // The PID comes from that file, not stdout: on macOS a pipe write is asynchronous, so the kill
    // can land before stdout is flushed (#550).
    const parentScript =
      'require("node:fs").writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1000)';
    const execution = backend.exec(
      runId,
      makeSpec([process.execPath, "-e", parentScript], { timeoutMs: 20_000 }),
      controller.signal,
    );
    const pidFile = join(workspaceRoot, runId, "project", "child.pid");
    const childPid = await vi.waitFor(
      async () => {
        const pid = Number(await readFile(pidFile, "utf8"));
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        return pid;
      },
      { timeout: 15_000, interval: 20 },
    );
    const childStartTime = readProcessStat(childPid)?.[19];
    controller.abort();
    const result = await execution;

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGKILL");
    await expectProcessExit(childPid, childStartTime);
  }, 30_000);

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

  // threat: T-14
  it("uses a distinct project directory for each in-process run", async () => {
    const otherRunId = Id.parse("00000000000000000000000002");
    const backend = createBackend();
    const first = await backend.exec(
      runId,
      makeSpec([
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync("private.txt", "first")',
      ]),
      new AbortController().signal,
    );
    const second = await backend.exec(
      otherRunId,
      makeSpec([process.execPath, "-e", "process.stdout.write(process.cwd())"]),
      new AbortController().signal,
    );

    expect(first.exitCode).toBe(0);
    expect(second.stdout).toBe(join(await realpath(workspaceRoot), otherRunId, "project"));
    await expect(
      backend.exec(
        otherRunId,
        makeSpec([process.execPath, "-e", "process.exit(0)"], {
          cwd: `../../${runId}/project`,
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "sandbox_workspace_path_invalid" });
  });

  it("sets TMPDIR to an absolute sibling of the canonical project root", async () => {
    const backend = new InProcessBackend({
      workspaceRoot: relative(process.cwd(), workspaceRoot),
      logger,
    });
    const result = await backend.exec(
      runId,
      makeSpec([process.execPath, "-e", "process.stdout.write(process.env.TMPDIR ?? '')"]),
      new AbortController().signal,
    );
    const expected = await realpath(join(workspaceRoot, runId, ".harness", "tmp"));

    expect(isAbsolute(result.stdout)).toBe(true);
    expect(result.stdout).toBe(expected);
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
