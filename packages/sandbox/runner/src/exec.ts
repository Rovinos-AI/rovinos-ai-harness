// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import process from "node:process";
import { HarnessError } from "@harness/schemas";
import { resolveWorkspacePath } from "../../src/inprocess.js";
import type { Clock, ExecResult, ExecSpec } from "../../src/types.js";

const PRLIMIT_PATH = "/usr/bin/prlimit";
const SETPRIV_PATH = "/usr/bin/setpriv";
const TRUSTED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const SANDBOX_EXEC_UID = 10003;
const SANDBOX_EXEC_GID = 10003;

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

function killProcessGroup(pid: number, executionUid: number): void {
  if (process.geteuid === undefined || process.seteuid === undefined) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group may have exited before the timeout or abort was observed.
    }
    return;
  }
  const serverUid = process.geteuid();
  try {
    if (serverUid !== executionUid) {
      process.seteuid(executionUid);
    }
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group may have exited before the timeout or abort was observed.
  } finally {
    if (serverUid !== executionUid) {
      process.seteuid(serverUid);
    }
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
  const dropBoundingSet = process.geteuid?.() !== executionUid;
  return [
    `--reuid=${String(executionUid)}`,
    `--regid=${String(executionGid)}`,
    "--keep-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    ...(dropBoundingSet ? ["--bounding-set=-all"] : []),
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
}

function executeProcess({
  spec,
  cwd,
  signal,
  clock,
  startedAt,
  executionUid,
  executionGid,
}: ProcessOptions): Promise<ExecResult> {
  const output = new CapturedOutput(spec.limits.outputBytes);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(SETPRIV_PATH, setprivArgs(spec, executionUid, executionGid), {
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
      cancelTimeout();
      if (child.pid !== undefined) {
        killProcessGroup(child.pid, executionUid);
      }
      signal.removeEventListener("abort", abort);
      if (spawnFailed) {
        reject(new RunnerExecError());
        return;
      }
      resolve({
        exitCode,
        ...(childSignal === null ? {} : { signal: childSignal }),
        ...output.result(),
        timedOut,
        durationMs: Math.max(0, Math.round(clock.now() - startedAt)),
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
  clock?: Clock;
  executionUid?: number;
  executionGid?: number;
}): Promise<ExecResult> {
  const { spec, signal, workspaceRoot } = options;
  const clock = options.clock ?? systemClock;
  const startedAt = clock.now();
  if (signal.aborted) {
    return abortedResult();
  }
  // Per-run workspace isolation is enforced by task 19.5; this execution resolves only the shared root for now.
  const cwd = await resolveWorkspacePath(workspaceRoot, spec.cwd);
  return executeProcess({
    spec,
    cwd,
    signal,
    clock,
    startedAt,
    executionUid: options.executionUid ?? SANDBOX_EXEC_UID,
    executionGid: options.executionGid ?? SANDBOX_EXEC_GID,
  });
}
