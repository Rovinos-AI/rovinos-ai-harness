// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import process from "node:process";
import { HarnessError, type Code, type Id } from "@harness/schemas";
import type { Clock, ExecResult, ExecSpec, SandboxBackend } from "./types.js";

const UNSAFE_LOG_CODE: Code = "sandbox_inprocess_unsafe";
const DEFAULT_CLOCK: Clock = { now: () => Date.now() };

/** Logger that accepts only a safe code and never receives command contents. */
export interface InProcessLogger {
  /** Emits the stable in-process backend warning code. */
  log(code: Code): void;
}

/** Configuration for the development-only local process backend. */
export interface InProcessBackendOptions {
  /** Trusted workspace root used to resolve every requested working directory. */
  readonly workspaceRoot: string;
  /** Explicitly permits the development backend in a production Node environment. */
  readonly allowUnsafeInProcess?: boolean;
  /** Clock used to calculate execution duration. */
  readonly clock?: Clock;
  /** Required safe-code logger notified whenever this backend starts. */
  readonly logger: InProcessLogger;
}

/** Error raised when the unsafe development backend is enabled in production. */
export class InProcessBackendError extends HarnessError {
  readonly code = "sandbox_inprocess_production";

  constructor() {
    super("The in-process sandbox backend is disabled in production.");
  }
}

/** Error raised when a working directory is not inside the workspace. */
export class SandboxWorkspacePathError extends HarnessError {
  readonly code = "sandbox_workspace_path_invalid";

  constructor() {
    super("The requested working directory is outside the workspace.");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

/**
 * Resolve an optional workspace-relative directory while rejecting traversal and symlink escapes.
 *
 * @param workspaceRoot - Trusted workspace directory.
 * @param workspacePath - Relative directory requested by the caller.
 * @returns A canonical path contained by the workspace.
 */
export async function resolveWorkspacePath(
  workspaceRoot: string,
  workspacePath = ".",
): Promise<string> {
  let realRoot: string;
  try {
    realRoot = await realpath(workspaceRoot);
  } catch {
    throw new SandboxWorkspacePathError();
  }
  if (isAbsolute(workspacePath)) {
    throw new SandboxWorkspacePathError();
  }
  const candidate = resolvePath(realRoot, workspacePath);
  if (!isWithin(realRoot, candidate)) {
    throw new SandboxWorkspacePathError();
  }
  let realCandidate: string;
  try {
    realCandidate = await realpath(candidate);
  } catch {
    throw new SandboxWorkspacePathError();
  }
  if (!isWithin(realRoot, realCandidate)) {
    throw new SandboxWorkspacePathError();
  }
  return realCandidate;
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
    const chunks = stream === "stdout" ? this.#stdout : this.#stderr;
    if (stream === "stdout") {
      this.#stdoutBytes += chunk.byteLength;
    } else {
      this.#stderrBytes += chunk.byteLength;
    }
    const remaining = Math.max(0, this.#maxBytes - this.#capturedBytes);
    const captured = chunk.subarray(0, remaining);
    if (captured.byteLength > 0) {
      chunks.push(captured);
      this.#capturedBytes += captured.byteLength;
    }
    if (captured.byteLength < chunk.byteLength) {
      this.#truncated = true;
    }
  }

  result(): Pick<ExecResult, "stdout" | "stderr" | "stdoutBytes" | "stderrBytes" | "truncated"> {
    return {
      stdout: Buffer.concat(this.#stdout).toString("utf8"),
      stderr: Buffer.concat(this.#stderr).toString("utf8"),
      stdoutBytes: this.#stdoutBytes,
      stderrBytes: this.#stderrBytes,
      truncated: this.#truncated,
    };
  }
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group may already have exited before the timeout or abort was observed.
  }
}

/**
 * Development-only backend. It is not an isolation boundary and relies on the remote runner
 * to enforce CPU, memory, PID, network, and filesystem restrictions.
 */
export class InProcessBackend implements SandboxBackend {
  readonly #workspaceRoot: string;
  readonly #clock: Clock;

  /**
   * Create the local backend, recording the unsafe-backend code at startup.
   *
   * @param options - Workspace, opt-in, clock, and safe-code logger.
   * @throws InProcessBackendError if production use has not been explicitly enabled.
   */
  constructor(options: InProcessBackendOptions) {
    options.logger.log(UNSAFE_LOG_CODE);
    if (process.env.NODE_ENV === "production" && options.allowUnsafeInProcess !== true) {
      throw new InProcessBackendError();
    }
    this.#workspaceRoot = options.workspaceRoot;
    this.#clock = options.clock ?? DEFAULT_CLOCK;
  }

  /** {@inheritDoc SandboxBackend.exec} */
  async exec(_runId: Id, spec: ExecSpec, signal: AbortSignal): Promise<ExecResult> {
    const startedAt = this.#clock.now();
    if (signal.aborted) {
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
    const command = spec.argv[0];
    if (command === undefined || command.length === 0) {
      throw new Error("An executable is required.");
    }
    const cwd = await resolveWorkspacePath(this.#workspaceRoot, spec.cwd);
    const output = new CapturedOutput(spec.limits.outputBytes);
    const child = spawn(command, spec.argv.slice(1), {
      shell: false,
      detached: true,
      cwd,
      env: { PATH: process.env.PATH ?? "", ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new Promise((resolve, reject) => {
      let timedOut = false;
      let spawnFailed = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          killProcessGroup(child.pid);
        }
      }, spec.timeoutMs);
      const abort = (): void => {
        if (child.pid !== undefined) {
          killProcessGroup(child.pid);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        output.add("stdout", chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output.add("stderr", chunk);
      });
      child.stdin.on("error", () => undefined);
      child.once("error", () => {
        spawnFailed = true;
      });
      child.once("close", (exitCode, childSignal) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (spawnFailed) {
          reject(new Error("The command could not be started."));
          return;
        }
        resolve({
          exitCode,
          ...(childSignal === null ? {} : { signal: childSignal }),
          ...output.result(),
          timedOut,
          durationMs: Math.max(0, Math.round(this.#clock.now() - startedAt)),
        });
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      child.stdin.end(spec.stdin ?? "");
    });
  }
}
