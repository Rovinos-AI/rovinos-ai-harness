// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@rovinos/schemas";
import { runDockerProcess } from "@rovinos/sandbox";
import type { DockerProcessResult } from "@rovinos/sandbox";
import type { PreparedTrial, TrialExecutionDependencies } from "../executor.js";
import { appendTrialProcessOutput } from "../execution-capture.js";
import { dockerEnvironment } from "./docker-args.js";

/** Closed error codes raised by Docker trial setup and process execution. */
export type DockerExecutorErrorCode =
  "docker_mount_path_invalid" | "docker_process_failed" | "docker_process_cancelled";

/** Stable, message-safe Docker executor error. */
export class DockerExecutorError extends HarnessError {
  readonly code: DockerExecutorErrorCode;

  constructor(code: DockerExecutorErrorCode) {
    super(code);
    this.code = code;
  }
}

interface DockerInvocation {
  readonly options: { readonly dockerPath: string; readonly timeoutMs: number };
  readonly prepared: PreparedTrial;
  readonly name: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly signal?: AbortSignal;
  readonly exportTelemetry?: boolean;
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DockerExecutorError("docker_process_cancelled");
  }
}

/** Executes one trial process with bounded, named-container cancellation. */
export async function runDocker(invocation: DockerInvocation): Promise<DockerProcessResult> {
  const { signal } = invocation;
  assertNotCancelled(signal);
  const env = dockerEnvironment(invocation.prepared.key, invocation.exportTelemetry);
  try {
    const outcome = await runDockerProcess({
      dockerPath: invocation.options.dockerPath,
      args: invocation.args,
      input: invocation.input,
      timeoutMs: invocation.options.timeoutMs,
      containerName: invocation.name,
      env,
      ...(signal === undefined ? {} : { signal }),
    });
    assertNotCancelled(signal);
    appendTrialProcessOutput(
      invocation.prepared.dbPath,
      outcome.stdout ?? "",
      outcome.stderr ?? "",
    );
    return outcome;
  } catch (error) {
    assertNotCancelled(signal);
    if (error instanceof DockerExecutorError) {
      throw error;
    }
    throw new DockerExecutorError("docker_process_failed");
  }
}

/** Carries executor-owned cancellation and telemetry settings into runs and resumes. */
export function dockerInvocationDependencies(
  dependencies: TrialExecutionDependencies,
): Pick<DockerInvocation, "signal" | "exportTelemetry"> {
  return {
    ...(dependencies.liveModel?.signal === undefined
      ? {}
      : { signal: dependencies.liveModel.signal }),
    ...(dependencies.exportTelemetry === undefined
      ? {}
      : { exportTelemetry: dependencies.exportTelemetry }),
  };
}
