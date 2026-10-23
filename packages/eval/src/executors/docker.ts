// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { foldRunState } from "@harness/core";
import { SqliteEventStore } from "@harness/store-sqlite";
import type { RunStatus } from "@harness/schemas";
import { z } from "zod";
import { TrialResultSchema } from "../trial.js";
import type { TrialResult, TrialSpec } from "../trial.js";
import { prepareTrial } from "../executor.js";
import type { TrialExecutor } from "../executor.js";

const DockerOptionsSchema = z
  .object({
    image: z.string().min(1),
    dockerPath: z.string().min(1).default("docker"),
    network: z.string().min(1).default("none"),
    timeoutMs: z.number().int().positive().default(3_600_000),
  })
  .strict();

/** Options for running an isolated trial in a container. */
export type DockerExecutorOptions = z.input<typeof DockerOptionsSchema>;

interface ChildOutcome {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

interface DockerInvocation {
  readonly dockerPath: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly timeoutMs: number;
  readonly name: string;
  readonly key: string;
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

async function stopContainer(dockerPath: string, name: string): Promise<void> {
  try {
    await execa(dockerPath, ["kill", name], {
      reject: false,
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    return;
  }
}

async function runContainer({
  dockerPath,
  args,
  input,
  timeoutMs,
  name,
  key,
}: DockerInvocation): Promise<ChildOutcome> {
  const child = execa(dockerPath, [...args], {
    input,
    reject: false,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, HARNESS_EVAL_KEY: key },
  });
  const completion = child.then(
    ({ exitCode }) => ({ exitCode: exitCode ?? null, timedOut: false }),
    () =>
      Promise.reject(
        Object.assign(new Error("docker_process_failed"), { code: "docker_process_failed" }),
      ),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    completion,
    new Promise<ChildOutcome>((resolve) => {
      timeout = setTimeout(() => {
        resolve({ exitCode: null, timedOut: true });
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
  if (!outcome.timedOut) {
    return outcome;
  }
  await stopContainer(dockerPath, name);
  child.kill("SIGTERM");
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    completion.then(
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
  return outcome;
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
  dbPath: string,
  workspaceDir: string,
  durationMs: number,
): Promise<TrialResult> {
  if (!existsSync(dbPath)) {
    return TrialResultSchema.parse({
      status: "error",
      dbPath,
      workspaceDir,
      durationMs,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
      exitCode: 1,
      errorCode: "trial_result_unavailable",
    });
  }
  const store = new SqliteEventStore(dbPath);
  try {
    const { runs } = await store.listRuns({ limit: 1 });
    const summary = runs[0];
    if (summary === undefined) {
      throw new Error("trial_run_missing");
    }
    const events = [];
    for await (const event of store.read(summary.runId)) {
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
      dbPath,
      workspaceDir,
      durationMs,
      usage: state.usage,
    });
  } catch {
    return TrialResultSchema.parse({
      status: "error",
      dbPath,
      workspaceDir,
      durationMs,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
      exitCode: 1,
      errorCode: "trial_result_unavailable",
    });
  } finally {
    await store.close();
  }
}

/**
 * Executes trials in the configured harness image with network disabled by default.
 *
 * @param options - Container image, network, and wall-clock timeout.
 */
export class DockerExecutor implements TrialExecutor {
  private readonly options: z.output<typeof DockerOptionsSchema>;

  constructor(options: DockerExecutorOptions) {
    this.options = DockerOptionsSchema.parse(options);
  }

  /** {@inheritDoc TrialExecutor.run} */
  async run(trial: TrialSpec): Promise<TrialResult> {
    const startedAt = performance.now();
    const prepared = await prepareTrial(trial);
    if (trial.workDir.includes(",")) {
      throw Object.assign(new Error("docker_mount_path_invalid"), {
        code: "docker_mount_path_invalid",
      });
    }
    const name = codeFromTrial(trial);
    const args = [
      "run",
      "--rm",
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
    const outcome = await runContainer({
      dockerPath: this.options.dockerPath,
      args,
      input: inputForTrial(trial),
      timeoutMs: this.options.timeoutMs,
      name,
      key: prepared.key,
    });
    const durationMs = Math.max(0, Math.floor(performance.now() - startedAt));
    const storedResult = await readRunResult(prepared.dbPath, prepared.workspaceDir, durationMs);
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
