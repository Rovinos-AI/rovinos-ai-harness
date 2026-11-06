// SPDX-License-Identifier: Apache-2.0
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { HarnessError } from "@rovinos/schemas";

/** Closed error codes for Docker launch failure and caller cancellation. */
export type DockerProcessErrorCode = "docker_process_failed" | "docker_process_cancelled";

/** Stable error raised for a Docker CLI process failure. */
export class DockerProcessError extends HarnessError {
  readonly code: DockerProcessErrorCode;

  constructor(code: DockerProcessErrorCode = "docker_process_failed") {
    super(code);
    this.code = code;
  }
}

/** Result of a Docker CLI process and its wall-clock timeout. */
export interface DockerProcessResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** Arguments for running one named Docker container with bounded time. */
export interface DockerProcessOptions {
  readonly dockerPath: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly timeoutMs: number;
  readonly containerName: string;
  readonly env: NodeJS.ProcessEnv;
  /** Stops the launch process before cleaning up the named container. */
  readonly signal?: AbortSignal;
}

function completion(child: ChildProcess): Promise<DockerProcessResult> {
  return new Promise((resolve, reject) => {
    child.once("error", () => {
      reject(new DockerProcessError());
    });
    child.once("close", (exitCode) => {
      resolve({ exitCode, timedOut: false, stdout: "", stderr: "" });
    });
  });
}

/** Reports whether the Docker CLI can reach its daemon. */
export function isDockerAvailable(dockerPath = "docker"): boolean {
  try {
    return (
      spawnSync(dockerPath, ["info"], {
        shell: false,
        stdio: "ignore",
        timeout: 5_000,
      }).status === 0
    );
  } catch {
    return false;
  }
}

function removeContainer(options: DockerProcessOptions): Promise<void> {
  let child: ChildProcess;
  try {
    child = spawn(options.dockerPath, ["rm", "--force", options.containerName], {
      stdio: "ignore",
      shell: false,
      env: options.env,
    });
  } catch {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("error", () => {
      finish();
    });
    child.once("close", () => {
      finish();
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish();
    }, 5_000);
  });
}

function watchCancellation(child: ChildProcess, signal?: AbortSignal) {
  let cancelled = false;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<DockerProcessResult>((resolve) => {
    if (signal === undefined) {
      return;
    }
    onAbort = () => {
      cancelled = true;
      // Kill the launcher first: a not-yet-created container must never start after cancellation.
      child.kill("SIGKILL");
      resolve({ exitCode: null, timedOut: false });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  return {
    interrupted,
    cancelled: () => cancelled,
    close: () => {
      if (onAbort !== undefined) {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function waitForExit(exited: Promise<DockerProcessResult>): Promise<void> {
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      grace = setTimeout(resolve, 5_000);
    }),
  ]).finally(() => {
    if (grace !== undefined) {
      clearTimeout(grace);
    }
  });
}

/**
 * Runs Docker using argv only; stops its launcher before cleanup on timeout or cancellation.
 *
 * @param options - Executable, arguments, input, timeout, cancellation, and container name.
 * @returns The process exit code and whether the timeout elapsed.
 */
export async function runDockerProcess(
  options: DockerProcessOptions,
): Promise<DockerProcessResult> {
  if (options.signal?.aborted === true) {
    throw new DockerProcessError("docker_process_cancelled");
  }
  let child: ChildProcess;
  try {
    child = spawn(options.dockerPath, [...options.args], {
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new DockerProcessError();
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  const getOutput = (): Pick<DockerProcessResult, "stdout" | "stderr"> => ({
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  });
  const exited = completion(child).then((result) => ({ ...result, ...getOutput() }));
  const cancellation = watchCancellation(child, options.signal);
  child.stdin?.end(options.input);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    exited,
    cancellation.interrupted,
    new Promise<DockerProcessResult>((resolve) => {
      timeout = setTimeout(() => {
        resolve({ exitCode: null, timedOut: true, ...getOutput() });
      }, options.timeoutMs);
    }),
  ]).finally(() => {
    cancellation.close();
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
  if (!result.timedOut && !cancellation.cancelled()) {
    return result;
  }
  if (result.timedOut) {
    child.kill("SIGKILL");
  }
  await waitForExit(exited);
  await removeContainer(options);
  if (cancellation.cancelled()) {
    throw new DockerProcessError("docker_process_cancelled");
  }
  return result;
}
