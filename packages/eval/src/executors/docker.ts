// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { foldRunState } from "@harness/core";
import { SqliteEventStore } from "@harness/store-sqlite";
import { RunStatus } from "@harness/schemas";
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

function codeFromTrial(trial: TrialSpec): string {
  const hash = createHash("sha256")
    .update(`${trial.task.id}\u0000${trial.variantId}\u0000${trial.trialIndex}`)
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

function stopContainer(dockerPath: string, name: string): void {
  const killer = spawn(dockerPath, ["kill", name], { stdio: "ignore" });
  killer.once("error", () => undefined);
}

function runContainer(
  dockerPath: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
  name: string,
  key: string,
): Promise<ChildOutcome> {
  return new Promise((resolveOutcome, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(dockerPath, [...args], {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, HARNESS_EVAL_KEY: key },
      });
    } catch {
      reject(Object.assign(new Error("docker_spawn_failed"), { code: "docker_spawn_failed" }));
      return;
    }
    let settled = false;
    let timedOut = false;
    let timeoutGrace: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ChildOutcome): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (timeoutGrace !== undefined) {
          clearTimeout(timeoutGrace);
        }
        resolveOutcome(outcome);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutGrace = setTimeout(() => finish({ exitCode: null, timedOut: true }), 5_000);
      stopContainer(dockerPath, name);
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (timeoutGrace !== undefined) {
          clearTimeout(timeoutGrace);
        }
        reject(Object.assign(new Error("docker_process_failed"), { code: "docker_process_failed" }));
      }
    });
    child.once("close", (exitCode) => finish({ exitCode, timedOut }));
    child.stdin?.end(input);
  });
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
      throw Object.assign(new Error("docker_mount_path_invalid"), { code: "docker_mount_path_invalid" });
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
      `type=bind,source=${trial.workDir},target=/harness`,
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
    const outcome = await runContainer(
      this.options.dockerPath,
      args,
      inputForTrial(trial),
      this.options.timeoutMs,
      name,
      prepared.key,
    );
    const durationMs = Math.max(0, Math.floor(performance.now() - startedAt));
    const readback = await readRunResult(
      prepared.dbPath,
      prepared.workspaceDir,
      durationMs,
    );
    if (outcome.timedOut) {
      return TrialResultSchema.parse({
        ...readback,
        status: "error",
        exitCode: outcome.exitCode ?? 124,
        errorCode: "trial_timeout",
      });
    }
    return TrialResultSchema.parse({
      ...readback,
      exitCode: outcome.exitCode ?? 1,
      ...(readback.status === "error" ? { errorCode: "docker_exit_nonzero" } : {}),
    });
  }
}
