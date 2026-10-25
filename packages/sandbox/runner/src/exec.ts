// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import process from "node:process";
import { HarnessError } from "@rovinos/schemas";
import { activateRunWorkspace, resolveWorkspacePath } from "../../src/workspace.js";
import type { Id } from "@rovinos/schemas";
import type { Clock, ExecResult, ExecSpec } from "../../src/types.js";

const PRLIMIT_PATH = "/usr/bin/prlimit";
const SETPRIV_PATH = "/usr/bin/setpriv";
const TRUSTED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const SANDBOX_EXEC_UID = 10003;
export const SANDBOX_EXEC_GID = 10003;

type SpawnProcess = (
  file: string,
  args: readonly string[],
  options: {
    shell: false;
    detached: boolean;
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "pipe";
  },
) => ChildProcess;

const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** Error raised when the resource-limited process cannot be started. */
export class RunnerExecError extends HarnessError {
  readonly code = "sandbox_exec_failed";

  constructor() {
    super("The sandbox command could not be started.");
  }
}

class CapturedOutput {
  readonly #maxBytes: number;
  readonly #stdout: Buffer[] = [];
  readonly #stderr: Buffer[] = [];
  #capturedBytes = 0;
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  add(stream: "stdout" | "stderr", chunk: Buffer): void {
    if (stream === "stdout") {
      this.#stdoutBytes += chunk.byteLength;
    } else {
      this.#stderrBytes += chunk.byteLength;
    }
    const remaining = Math.max(0, this.#maxBytes - this.#capturedBytes);
    const captured = chunk.subarray(0, remaining);
    if (captured.byteLength > 0) {
      (stream === "stdout" ? this.#stdout : this.#stderr).push(captured);
      this.#capturedBytes += captured.byteLength;
    }
    if (captured.byteLength < chunk.byteLength) {
      this.#truncated = true;
    }
  }

  result(): Pick<ExecResult, "stdout" | "stderr" | "stdoutBytes" | "stderrBytes" | "truncated"> {
    return {
      stdout: new TextDecoder().decode(Buffer.concat(this.#stdout)),
      stderr: new TextDecoder().decode(Buffer.concat(this.#stderr)),
      stdoutBytes: this.#stdoutBytes,
      stderrBytes: this.#stderrBytes,
      truncated: this.#truncated,
    };
  }
}

/** Sends SIGKILL to a process group using its execution credentials. */
export function killProcessGroup(pid: number, executionUid: number): void {
  const serverUid = process.geteuid?.();
  try {
    if (serverUid !== undefined && serverUid !== executionUid) {
      process.seteuid?.(executionUid);
    }
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group may have exited before the timeout or abort was observed.
  } finally {
    if (serverUid !== undefined && serverUid !== executionUid) {
      process.seteuid?.(serverUid);
    }
  }
}

function linuxProcessGroupHasLiveMembers(pid: number): boolean {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    try {
      const status = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = status.slice(status.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/** Reports whether a process group still has live members. */
export function processGroupExists(pid: number): boolean {
  if (process.platform === "linux") {
    return linuxProcessGroupHasLiveMembers(pid);
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code !== "ESRCH";
  }
}

async function waitForProcessGroupExit(pid: number): Promise<void> {
  while (processGroupExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function prlimitArgs(spec: ExecSpec): string[] {
  const memoryBytes = BigInt(spec.limits.memoryMb) * 1_048_576n;
  return [
    `--as=${String(memoryBytes)}`,
    `--nproc=${String(spec.limits.pids)}`,
    `--cpu=${String(spec.limits.cpuSeconds)}`,
    `--fsize=${String(spec.limits.outputBytes)}`,
    "--",
    ...spec.argv,
  ];
}

function setprivArgs(spec: ExecSpec, executionUid: number, executionGid: number): string[] {
  return [
    `--reuid=${String(executionUid)}`,
    `--regid=${String(executionGid)}`,
    "--clear-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    "--",
    PRLIMIT_PATH,
    ...prlimitArgs(spec),
  ];
}

function abortedResult(): ExecResult {
  return {
    exitCode: null,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    timedOut: false,
    durationMs: 0,
  };
}

interface ProcessOptions {
  spec: ExecSpec;
  cwd: string;
  signal: AbortSignal;
  clock: Clock;
  startedAt: number;
  executionUid: number;
  executionGid: number;
  spawnProcess: SpawnProcess;
}

interface ProcessCompletionOptions {
  readonly childPid: number | undefined;
  readonly executionUid: number;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly cancelTimeout: () => void;
  readonly spawnFailed: boolean;
  readonly exitCode: number | null;
  readonly childSignal: NodeJS.Signals | null;
  readonly output: CapturedOutput;
  readonly timedOut: boolean;
  readonly clock: Clock;
  readonly startedAt: number;
  readonly resolve: (result: ExecResult) => void;
  readonly reject: (error: unknown) => void;
}

function completeProcess(options: ProcessCompletionOptions): void {
  options.cancelTimeout();
  if (options.childPid !== undefined) {
    killProcessGroup(options.childPid, options.executionUid);
  }
  const exited =
    options.childPid === undefined ? Promise.resolve() : waitForProcessGroupExit(options.childPid);
  void exited.then(() => {
    options.signal.removeEventListener("abort", options.abort);
    if (options.spawnFailed) {
      options.reject(new RunnerExecError());
      return;
    }
    options.resolve({
      exitCode: options.exitCode,
      ...(options.childSignal === null ? {} : { signal: options.childSignal }),
      ...options.output.result(),
      timedOut: options.timedOut,
      durationMs: Math.max(0, Math.round(options.clock.now() - options.startedAt)),
    });
  }, options.reject);
}

function executeProcess({
  spec,
  cwd,
  signal,
  clock,
  startedAt,
  executionUid,
  executionGid,
  spawnProcess,
}: ProcessOptions): Promise<ExecResult> {
  const output = new CapturedOutput(spec.limits.outputBytes);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawnProcess(SETPRIV_PATH, setprivArgs(spec, executionUid, executionGid), {
      shell: false,
      detached: true,
      cwd,
      env: { ...spec.env, PATH: TRUSTED_PATH },
      stdio: "pipe",
    });
  } catch {
    throw new RunnerExecError();
  }
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null || stderr === null) {
    if (child.pid !== undefined) {
      killProcessGroup(child.pid, executionUid);
    }
    throw new RunnerExecError();
  }

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let spawnFailed = false;
    const cancelTimeout = clock.schedule(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        killProcessGroup(child.pid, executionUid);
      }
    }, spec.timeoutMs);
    const abort = (): void => {
      if (child.pid !== undefined) {
        killProcessGroup(child.pid, executionUid);
      }
    };
    stdout.on("data", (chunk: Buffer) => {
      output.add("stdout", chunk);
    });
    stderr.on("data", (chunk: Buffer) => {
      output.add("stderr", chunk);
    });
    stdin.on("error", () => undefined);
    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", (exitCode, childSignal) => {
      completeProcess({
        childPid: child.pid,
        executionUid,
        signal,
        abort,
        cancelTimeout,
        spawnFailed,
        exitCode,
        childSignal,
        output,
        timedOut,
        clock,
        startedAt,
        resolve,
        reject,
      });
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    stdin.end(spec.stdin ?? "");
  });
}

/**
 * Runs a command through util-linux prlimit in the workspace with all child limits applied.
 *
 * @param options - Validated command, cancellation signal, workspace, and clock.
 * @returns Bounded command output and process metadata.
 */
export async function executeSpec(options: {
  spec: ExecSpec;
  signal: AbortSignal;
  workspaceRoot: string;
  runId: Id;
  clock?: Clock;
  executionUid?: number;
  executionGid?: number;
  spawnProcess?: SpawnProcess;
}): Promise<ExecResult> {
  const { runId, spec, signal, workspaceRoot } = options;
  const clock = options.clock ?? systemClock;
  const startedAt = clock.now();
  if (signal.aborted) {
    return abortedResult();
  }
  const projectRoot = await activateRunWorkspace(workspaceRoot, runId);
  const cwd = await resolveWorkspacePath(projectRoot, spec.cwd);
  const tempDirectory = resolveWorkspacePath(workspaceRoot, `${runId}/.harness/tmp`);
  const tempPath = await tempDirectory;
  return executeProcess({
    spec: {
      ...spec,
      env: { ...spec.env, TMPDIR: tempPath },
    },
    cwd,
    signal,
    clock,
    startedAt,
    executionUid: options.executionUid ?? SANDBOX_EXEC_UID,
    executionGid: options.executionGid ?? SANDBOX_EXEC_GID,
    spawnProcess: options.spawnProcess ?? spawn,
  });
}
