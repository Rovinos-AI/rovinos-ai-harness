// SPDX-License-Identifier: Apache-2.0
import { resolve as resolvePath } from "node:path";
import { evalSuiteCode } from "../trial.js";
import type { TrialSpec } from "../trial.js";

interface DockerBaseOptions {
  readonly image: string;
  readonly network: string;
  readonly tmpfsSize: string;
  readonly user: string;
  readonly memory: string;
  readonly cpus: number;
  readonly pidsLimit: number;
}

function telemetryEnvironmentArgs(exportTelemetry: boolean | undefined): string[] {
  if (exportTelemetry !== true) {
    return [];
  }
  return [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
  ].flatMap((name) => (process.env[name] === undefined ? [] : ["--env", name]));
}

function evalMetadataForTrial(trial: TrialSpec): string {
  return JSON.stringify({
    suite: evalSuiteCode(trial.suite),
    task: trial.task.id,
    trial: trial.trialIndex,
  });
}

/** Build the security-constrained Docker arguments shared by each trial process. */
export function dockerBaseArgs(
  options: DockerBaseOptions,
  trial: TrialSpec,
  name: string,
  exportTelemetry: boolean | undefined,
): string[] {
  return [
    "run",
    "--rm",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--read-only",
    "--tmpfs",
    `/tmp:size=${options.tmpfsSize},noexec,nosuid,nodev`,
    "--user",
    options.user,
    "--memory",
    options.memory,
    "--cpus",
    String(options.cpus),
    "--pids-limit",
    String(options.pidsLimit),
    "--name",
    name,
    "--network",
    options.network,
    "--mount",
    `type=bind,source=${resolvePath(trial.workDir)},target=/harness`,
    "--workdir",
    "/harness",
    "--env",
    "HARNESS_DATA_DIR=/harness/data",
    "--env",
    "HARNESS_EVAL_KEY",
    "--env",
    `HARNESS_EVAL_METADATA=${evalMetadataForTrial(trial)}`,
    ...telemetryEnvironmentArgs(exportTelemetry),
    options.image,
  ];
}
