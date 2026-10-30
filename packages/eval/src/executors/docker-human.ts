// SPDX-License-Identifier: Apache-2.0
import { createRuntime, type Runtime } from "@rovinos/core";
import { HarnessError, type Id, type RunStatus } from "@rovinos/schemas";
import type { DockerProcessResult } from "@rovinos/sandbox";
import type { PreparedTrial, TrialExecutionDependencies } from "../executor.js";
import { SimulatedHuman } from "../human.js";
import type { HumanScript } from "../schema.js";
import type { ApprovalCounts } from "../trial.js";

/** Result of applying a human script to one suspended Docker trial. */
export interface DockerHumanResult {
  readonly approvals: ApprovalCounts;
  readonly unsafeAutoApprove: boolean;
  readonly maxResumesExceeded: boolean;
  readonly processTimedOut: boolean;
  readonly processExitCode: number;
}

class DockerHumanError extends HarnessError {
  readonly code = "docker_process_failed";

  constructor() {
    super("The Docker run could not be read.");
  }
}

/** Reads the run status and raises a coded failure if the run has disappeared. */
export async function readLatestStatus(
  store: Pick<Runtime["store"], "listRuns">,
  runId: Id,
): Promise<RunStatus> {
  const { runs } = await store.listRuns({ limit: 1 });
  const summary = runs.find((candidate) => candidate.runId === runId);
  if (summary === undefined) {
    throw new DockerHumanError();
  }
  return summary.status;
}

/**
 * Resolves approvals through the shared runtime and resumes the isolated Docker run.
 *
 * @param options - Trial runtime resources and an executor-owned resume callback.
 * @returns Approval counts, safety flag, and final process status metadata.
 */
export async function runDockerHuman(options: {
  readonly script: HumanScript;
  readonly prepared: PreparedTrial;
  readonly dependencies: TrialExecutionDependencies;
  readonly runId: Id;
  readonly initialStatus: RunStatus;
  readonly initialExitCode: number;
  readonly resumeProcess: () => Promise<DockerProcessResult>;
}): Promise<DockerHumanResult> {
  const runtime = await createRuntime(options.prepared.runtimeConfig, {
    dataDir: options.prepared.dataDir,
    transientVault: false,
    ...(options.dependencies.clock === undefined ? {} : { clock: options.dependencies.clock }),
    secretResolver: {
      resolve: () => Promise.resolve({ reveal: () => options.prepared.key }),
    },
  });
  let processExitCode = options.initialExitCode;
  let processTimedOut = false;
  try {
    const human = new SimulatedHuman(options.script, runtime);
    const result = await human.runUntilSettled(options.runId, options.initialStatus, async () => {
      const resumed = await options.resumeProcess();
      processExitCode = resumed.exitCode ?? 1;
      processTimedOut = resumed.timedOut;
      if (processTimedOut) {
        return "suspended";
      }
      return readLatestStatus(runtime.store, options.runId);
    });
    return {
      approvals: human.counts,
      unsafeAutoApprove: human.unsafeAutoApprove,
      maxResumesExceeded: result.maxResumesExceeded,
      processTimedOut,
      processExitCode,
    };
  } finally {
    await runtime.close();
  }
}
