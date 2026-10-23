// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createRuntime, foldRunState } from "@harness/core";
import { HarnessError } from "@harness/schemas";
import type { RunStatus } from "@harness/schemas";
import { runDockerProcess } from "@harness/sandbox";
import type { DockerProcessResult } from "@harness/sandbox";
import { z } from "zod";
import { TrialResultSchema } from "../trial.js";
import type { TrialResult, TrialSpec } from "../trial.js";
import { prepareTrial, systemClock } from "../executor.js";
import type { PreparedTrial, TrialExecutionDependencies, TrialExecutor } from "../executor.js";

const DockerOptionsSchema = z
  .object({
    image: z.string().min(1),
    dockerPath: z.string().min(1).default("docker"),
    network: z.string().min(1).default("none"),
    timeoutMs: z.number().int().positive().default(3_600_000),
    memory: z
      .string()
      .regex(/^\d+[bkmg]?$/iu)
      .default("1g"),
    cpus: z.number().positive().default(1),
    pidsLimit: z.number().int().positive().default(256),
    tmpfsSize: z
      .string()
      .regex(/^\d+[kmg]$/iu)
      .default("64m"),
    user: z
      .string()
      .regex(/^[1-9]\d*:[1-9]\d*$/u)
      .default("65532:65532"),
  })
  .strict();

/** Options for running an isolated trial in a container. */
export type DockerExecutorOptions = z.input<typeof DockerOptionsSchema>;

/** Closed error codes raised by Docker trial setup and process execution. */
export type DockerExecutorErrorCode = "docker_mount_path_invalid" | "docker_process_failed";

/** Stable, message-safe Docker executor error. */
export class DockerExecutorError extends HarnessError {
  readonly code: DockerExecutorErrorCode;

  constructor(code: DockerExecutorErrorCode) {
    super(code);
    this.code = code;
  }
}

function codeFromTrial(trial: TrialSpec): string {
  const hash = createHash("sha256")
    .update(`${trial.task.id}\u0000${trial.variantId}\u0000${String(trial.trialIndex)}`)
    .digest("hex")
    .slice(0, 20);
  return `harness-eval-${hash}`;
}

function inputForTrial(trial: TrialSpec): string {
  return JSON.stringify(
    trial.task.input.metadata === undefined
      ? { goal: trial.task.input.goal }
      : { goal: trial.task.input.goal, metadata: trial.task.input.metadata },
  );
}

function mapStatus(status: z.infer<typeof RunStatus>): TrialResult["status"] | undefined {
  if (
    status === "completed" ||
    status === "failed" ||
    status === "suspended" ||
    status === "cancelled"
  ) {
    return status;
  }
  return undefined;
}

async function readRunResult(
  prepared: PreparedTrial,
  durationMs: number,
  dependencies: TrialExecutionDependencies,
): Promise<TrialResult> {
  if (!existsSync(prepared.dbPath)) {
    return TrialResultSchema.parse({
      status: "error",
      dbPath: prepared.dbPath,
      workspaceDir: prepared.workspaceDir,
      durationMs,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
      exitCode: 1,
      errorCode: "trial_result_unavailable",
    });
  }
  const runtime = await createRuntime(prepared.runtimeConfig, {
    dataDir: prepared.dataDir,
    readOnlyStore: true,
    transientVault: false,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    secretResolver: {
      resolve: () => Promise.resolve({ reveal: () => prepared.key }),
    },
  });
  try {
    const { runs } = await runtime.store.listRuns({ limit: 1 });
    const summary = runs[0];
    if (summary === undefined) {
      throw new Error("trial_run_missing");
    }
    const events = [];
    for await (const event of runtime.store.read(summary.runId)) {
      events.push(event);
    }
    const state = foldRunState(events);
    const status = mapStatus(summary.status);
    if (status === undefined) {
      throw new Error("trial_status_unsettled");
    }
    return TrialResultSchema.parse({
      status,
      runId: summary.runId,
      dbPath: prepared.dbPath,
      workspaceDir: prepared.workspaceDir,
      durationMs,
      usage: state.usage,
    });
  } catch {
    return TrialResultSchema.parse({
      status: "error",
      dbPath: prepared.dbPath,
      workspaceDir: prepared.workspaceDir,
      durationMs,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
      exitCode: 1,
      errorCode: "trial_result_unavailable",
    });
  } finally {
    await runtime.close();
  }
}

/**
 * Executes trials in the configured harness image with network disabled by default.
 *
 * @param options - Container image, network, and wall-clock timeout.
 */
export class DockerExecutor implements TrialExecutor {
  private readonly options: z.output<typeof DockerOptionsSchema>;

  constructor(
    options: DockerExecutorOptions,
    private readonly dependencies: TrialExecutionDependencies = {},
  ) {
    this.options = DockerOptionsSchema.parse(options);
  }

  /** {@inheritDoc TrialExecutor.run} */
  async run(trial: TrialSpec): Promise<TrialResult> {
    const clock = this.dependencies.clock ?? systemClock;
    const startedAt = clock.now();
    if (trial.workDir.includes(",")) {
      throw new DockerExecutorError("docker_mount_path_invalid");
    }
    const prepared = await prepareTrial(trial, this.dependencies);
    const name = codeFromTrial(trial);
    const args = [
      "run",
      "--rm",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--read-only",
      "--tmpfs",
      `/tmp:size=${this.options.tmpfsSize},noexec,nosuid,nodev`,
      "--user",
      this.options.user,
      "--memory",
      this.options.memory,
      "--cpus",
      String(this.options.cpus),
      "--pids-limit",
      String(this.options.pidsLimit),
      "--name",
      name,
      "--network",
      this.options.network,
      "--mount",
      `type=bind,source=${resolvePath(trial.workDir)},target=/harness`,
      "--workdir",
      "/harness",
      "--env",
      "HARNESS_DATA_DIR=/harness/data",
      "--env",
      "HARNESS_EVAL_KEY",
      this.options.image,
      "node",
      "dist/bin.js",
      "--config",
      "/harness/harness.config.json",
      "run",
      "--input",
      "-",
    ];
    let outcome: DockerProcessResult;
    try {
      outcome = await runDockerProcess({
        dockerPath: this.options.dockerPath,
        args,
        input: inputForTrial(trial),
        timeoutMs: this.options.timeoutMs,
        containerName: name,
        env: { ...process.env, HARNESS_EVAL_KEY: prepared.key },
      });
    } catch {
      throw new DockerExecutorError("docker_process_failed");
    }
    const durationMs = Math.max(0, Math.floor(clock.now() - startedAt));
    const storedResult = await readRunResult(prepared, durationMs, this.dependencies);
    if (outcome.timedOut) {
      return TrialResultSchema.parse({
        ...storedResult,
        status: "error",
        exitCode: outcome.exitCode ?? 124,
        errorCode: "trial_timeout",
      });
    }
    return TrialResultSchema.parse({
      ...storedResult,
      exitCode: outcome.exitCode ?? 1,
      ...(storedResult.status === "error" ? { errorCode: "docker_exit_nonzero" } : {}),
    });
  }
}
