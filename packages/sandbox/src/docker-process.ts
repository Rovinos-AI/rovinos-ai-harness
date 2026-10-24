// SPDX-License-Identifier: Apache-2.0
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { HarnessError } from "@rovinos/schemas";

/** Closed error code raised when the Docker CLI cannot be started. */
export type DockerProcessErrorCode = "docker_process_failed";

/** Stable error raised for a Docker CLI process failure. */
export class DockerProcessError extends HarnessError {
  readonly code: DockerProcessErrorCode = "docker_process_failed";

  constructor() {
    super("The Docker process failed.");
  }
}

/** Result of a Docker CLI process and its wall-clock timeout. */
export interface DockerProcessResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/** Arguments for running one named Docker container with bounded time. */
export interface DockerProcessOptions {
  readonly dockerPath: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly timeoutMs: number;
  readonly containerName: string;
  readonly env: NodeJS.ProcessEnv;
}

function completion(child: ChildProcess): Promise<DockerProcessResult> {
  return new Promise((resolve, reject) => {
    child.once("error", () => {
      reject(new DockerProcessError());
    });
    child.once("close", (exitCode) => {
      resolve({ exitCode, timedOut: false });
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

function stopContainer(dockerPath: string, containerName: string): Promise<void> {
  let child: ChildProcess;
  try {
    child = spawn(dockerPath, ["kill", containerName], { stdio: "ignore", shell: false });
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

/**
 * Runs Docker using argv only, discards process output, and kills a timed-out container.
 *
 * @param options - Executable, arguments, input, timeout, and isolated container name.
 * @returns The process exit code and whether the timeout elapsed.
 */
export async function runDockerProcess(
  options: DockerProcessOptions,
): Promise<DockerProcessResult> {
  let child: ChildProcess;
  try {
    child = spawn(options.dockerPath, [...options.args], {
      env: options.env,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    throw new DockerProcessError();
  }
  const exited = completion(child);
  child.stdin?.end(options.input);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    exited,
    new Promise<DockerProcessResult>((resolve) => {
      timeout = setTimeout(() => {
        resolve({ exitCode: null, timedOut: true });
      }, options.timeoutMs);
    }),
  ]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
  if (!result.timedOut) {
    return result;
  }
  await stopContainer(options.dockerPath, options.containerName);
  child.kill("SIGTERM");
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      grace = setTimeout(() => {
        resolve();
      }, 5_000);
    }),
  ]).finally(() => {
    if (grace !== undefined) {
      clearTimeout(grace);
    }
  });
  return result;
}
