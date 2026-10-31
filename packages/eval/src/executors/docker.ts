// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRuntime, foldRunState } from "@rovinos/core";
import { HarnessError, type Event, type RunStatus } from "@rovinos/schemas";
import { runDockerProcess } from "@rovinos/sandbox";
import type { DockerProcessResult } from "@rovinos/sandbox";
import { z } from "zod";
import {
  TrialResultSchema,
  type ApprovalCounts,
  type TrialResult,
  type TrialSpec,
} from "../trial.js";
import { prepareTrial, systemClock } from "../executor.js";
import type { PreparedTrial, TrialExecutionDependencies, TrialExecutor } from "../executor.js";
import { appendTrialProcessOutput } from "../execution-capture.js";
import { dockerBaseArgs } from "./docker-args.js";
import { runDockerHuman } from "./docker-human.js";
import { executionMetricsFromEvents } from "../report/metrics.js";

const DockerMemorySchema = z
  .string()
  .min(1)
  .max(16)
  .refine((value) => {
    const match = /^(\d+)([a-z]?)$/iu.exec(value);
    const amount = Number(match?.[1]);
    const unit = match?.[2]?.toLowerCase() ?? "";
    return (
      match !== null &&
      Number.isSafeInteger(amount) &&
      amount > 0 &&
      ["", "b", "k", "m", "g"].includes(unit)
    );
  });

const DockerTmpfsSizeSchema = z
  .string()
  .min(1)
  .max(16)
  .refine((value) => {
    const match = /^(\d+)([a-z])$/iu.exec(value);
    const amount = Number(match?.[1]);
    const unit = match?.[2]?.toLowerCase();
    return (
      match !== null &&
      Number.isSafeInteger(amount) &&
      amount > 0 &&
      ["k", "m", "g"].includes(unit ?? "")
    );
  });

const DockerOptionsSchema = z
  .object({
    image: z.string().min(1),
    dockerPath: z.string().min(1).default("docker"),
    network: z.string().min(1).default("none"),
    timeoutMs: z.number().int().positive().default(3_600_000),
    memory: DockerMemorySchema.default("1g"),
    cpus: z.number().positive().default(1),
    pidsLimit: z.number().int().positive().default(256),
    tmpfsSize: DockerTmpfsSizeSchema.default("64m"),
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

function trialKey(trial: TrialSpec): string {
  return `${trial.task.id}\u0000${trial.variantId}\u0000${String(trial.trialIndex)}`;
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
      metrics: executionMetricsFromEvents(events, state.steps),
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

interface DockerInvocation {
  readonly options: z.output<typeof DockerOptionsSchema>;
  readonly prepared: PreparedTrial;
  readonly name: string;
  readonly args: readonly string[];
  readonly input: string;
}

async function runDocker(invocation: DockerInvocation): Promise<DockerProcessResult> {
  try {
    const outcome = await runDockerProcess({
      dockerPath: invocation.options.dockerPath,
      args: invocation.args,
      input: invocation.input,
      timeoutMs: invocation.options.timeoutMs,
      containerName: invocation.name,
      env: { ...process.env, HARNESS_EVAL_KEY: invocation.prepared.key },
    });
    appendTrialProcessOutput(
      invocation.prepared.dbPath,
      outcome.stdout ?? "",
      outcome.stderr ?? "",
    );
    return outcome;
  } catch {
    throw new DockerExecutorError("docker_process_failed");
  }
}

function finishDockerResult(
  result: TrialResult,
  durationMs: number,
  values: {
    readonly exitCode: number;
    readonly approvals: ApprovalCounts;
    readonly unsafeAutoApprove: boolean;
    readonly maxResumesExceeded?: boolean;
    readonly timedOut?: boolean;
  },
): TrialResult {
  if (values.timedOut === true) {
    return TrialResultSchema.parse({
      ...result,
      status: "error",
      exitCode: 124,
      errorCode: "trial_timeout",
      approvals: values.approvals,
      unsafeAutoApprove: values.unsafeAutoApprove,
      durationMs,
    });
  }
  if (values.maxResumesExceeded === true) {
    return TrialResultSchema.parse({
      ...result,
      status: "error",
      exitCode: 1,
      errorCode: "human_max_resumes_exceeded",
      approvals: values.approvals,
      unsafeAutoApprove: values.unsafeAutoApprove,
      durationMs,
    });
  }
  return TrialResultSchema.parse({
    ...result,
    exitCode: values.exitCode,
    ...(result.status === "error" ? { errorCode: "docker_exit_nonzero" } : {}),
    approvals: values.approvals,
    unsafeAutoApprove: values.unsafeAutoApprove,
    durationMs,
  });
}

async function completeDockerTrial(options: {
  readonly trial: TrialSpec;
  readonly prepared: PreparedTrial;
  readonly dockerOptions: z.output<typeof DockerOptionsSchema>;
  readonly dockerArgs: readonly string[];
  readonly containerName: string;
  readonly outcome: DockerProcessResult;
  readonly startedAt: number;
  readonly clock: { now(): number };
  readonly dependencies: TrialExecutionDependencies;
}): Promise<TrialResult> {
  let result = await readRunResult(
    options.prepared,
    Math.max(0, Math.floor(options.clock.now() - options.startedAt)),
    options.dependencies,
  );
  const unsafeAutoApprove = options.trial.task.human?.unsafeAutoApprove === true;
  if (options.outcome.timedOut) {
    return TrialResultSchema.parse({
      ...result,
      status: "error",
      exitCode: options.outcome.exitCode ?? 124,
      errorCode: "trial_timeout",
      unsafeAutoApprove,
    });
  }
  const runId = result.runId;
  if (
    options.trial.task.human === undefined ||
    runId === undefined ||
    result.status !== "suspended"
  ) {
    return TrialResultSchema.parse({
      ...result,
      exitCode: options.outcome.exitCode ?? 1,
      ...(result.status === "error" ? { errorCode: "docker_exit_nonzero" } : {}),
      unsafeAutoApprove,
    });
  }
  const human = await runDockerHuman({
    script: options.trial.task.human,
    prepared: options.prepared,
    dependencies: options.dependencies,
    runId,
    initialStatus: result.status,
    initialExitCode: options.outcome.exitCode ?? 1,
    resumeProcess: () =>
      runDocker({
        options: options.dockerOptions,
        prepared: options.prepared,
        name: options.containerName,
        args: [
          ...options.dockerArgs,
          "node",
          "dist/bin.js",
          "--config",
          "/harness/harness.config.json",
          "resume",
          runId,
        ],
        input: "",
      }),
  });
  result = await readRunResult(
    options.prepared,
    Math.max(0, Math.floor(options.clock.now() - options.startedAt)),
    options.dependencies,
  );
  return finishDockerResult(
    result,
    Math.max(0, Math.floor(options.clock.now() - options.startedAt)),
    {
      exitCode: human.processExitCode,
      approvals: human.approvals,
      unsafeAutoApprove: human.unsafeAutoApprove,
      maxResumesExceeded: human.maxResumesExceeded,
      timedOut: human.processTimedOut,
    },
  );
}

/**
 * Executes trials in the configured harness image with network disabled by default.
 *
 * @param options - Container image, network, and wall-clock timeout.
 */
export class DockerExecutor implements TrialExecutor {
  private readonly options: z.output<typeof DockerOptionsSchema>;
  private readonly preparedTrials = new Map<string, PreparedTrial>();

  constructor(
    options: DockerExecutorOptions,
    private readonly dependencies: TrialExecutionDependencies = {},
  ) {
    this.options = DockerOptionsSchema.parse(options);
  }

  /** Reads the trial's tokenized event log after execution for grading and cassette recording. */
  async eventsFor(trial: TrialSpec): Promise<readonly Event[]> {
    const prepared = this.preparedTrials.get(trialKey(trial));
    this.preparedTrials.delete(trialKey(trial));
    if (prepared === undefined || !existsSync(prepared.dbPath)) {
      return [];
    }
    const runtime = await createRuntime(prepared.runtimeConfig, {
      dataDir: prepared.dataDir,
      readOnlyStore: true,
      transientVault: false,
      secretResolver: {
        resolve: (reference, signal) =>
          reference === "env:HARNESS_EVAL_KEY"
            ? Promise.resolve({ reveal: () => prepared.key })
            : (this.dependencies.secretResolver?.resolve(reference, signal) ??
              Promise.reject(
                Object.assign(new Error("secret_unavailable"), { code: "secret_unavailable" }),
              )),
      },
    });
    try {
      const { runs } = await runtime.store.listRuns({ limit: 1 });
      const run = runs[0];
      if (run === undefined) {
        return [];
      }
      const events: Event[] = [];
      for await (const event of runtime.store.read(run.runId)) {
        events.push(event);
      }
      return events;
    } finally {
      await runtime.close();
    }
  }

  /** {@inheritDoc TrialExecutor.run} */
  async run(trial: TrialSpec): Promise<TrialResult> {
    const clock = this.dependencies.clock ?? systemClock;
    const startedAt = clock.now();
    if (trial.workDir.includes(",")) {
      throw new DockerExecutorError("docker_mount_path_invalid");
    }
    const prepared = await prepareTrial(trial, this.dependencies);
    this.preparedTrials.set(trialKey(trial), prepared);
    const name = codeFromTrial(trial);
    const dockerArgs = dockerBaseArgs(this.options, trial, name, this.dependencies.exportTelemetry);
    const args = [
      ...dockerArgs,
      "node",
      "dist/bin.js",
      "--config",
      "/harness/harness.config.json",
      "run",
      "--input",
      "-",
    ];
    const outcome = await runDocker({
      options: this.options,
      prepared,
      name,
      args,
      input: inputForTrial(trial),
    });
    return completeDockerTrial({
      trial,
      prepared,
      dockerOptions: this.options,
      dockerArgs,
      containerName: name,
      outcome,
      startedAt,
      clock,
      dependencies: this.dependencies,
    });
  }
}
