// SPDX-License-Identifier: Apache-2.0
import { resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
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
  readonly modelSocket?: string;
}

/** Stable container name isolated to the task, variant, and trial index. */
export function dockerTrialName(trial: TrialSpec): string {
  const hash = createHash("sha256")
    .update(`${trial.task.id}\u0000${trial.variantId}\u0000${String(trial.trialIndex)}`)
    .digest("hex")
    .slice(0, 20);
  return `harness-eval-${hash}`;
}

/** Keeps goal content on stdin rather than exposing it in process arguments. */
export function dockerTrialInput(trial: TrialSpec): string {
  return JSON.stringify(
    trial.task.input.metadata === undefined
      ? { goal: trial.task.input.goal }
      : { goal: trial.task.input.goal, metadata: trial.task.input.metadata },
  );
}

const telemetryEnvironment = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
];

function telemetryEnvironmentArgs(exportTelemetry: boolean | undefined): string[] {
  if (exportTelemetry !== true) {
    return [];
  }
  return telemetryEnvironment.flatMap((name) =>
    process.env[name] === undefined ? [] : ["--env", name],
  );
}

/** Minimal Docker client environment; model provider credentials are deliberately excluded. */
export function dockerEnvironment(key: string, exportTelemetry?: boolean): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "XDG_RUNTIME_DIR",
    "SSH_AUTH_SOCK",
    ...(exportTelemetry === true ? telemetryEnvironment : []),
  ];
  return {
    ...Object.fromEntries(
      names.flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    ),
    HARNESS_EVAL_KEY: key,
  };
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
  const { modelSocket } = options;
  return [
    "run",
    "--rm",
    "--interactive",
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
    modelSocket === undefined ? options.network : "none",
    "--mount",
    `type=bind,source=${resolvePath(trial.workDir)},target=/harness`,
    "--workdir",
    "/harness",
    "--entrypoint",
    "node",
    "--env",
    "HARNESS_DATA_DIR=/harness/data",
    "--env",
    "HARNESS_EVAL_KEY",
    "--env",
    `HARNESS_EVAL_METADATA=${evalMetadataForTrial(trial)}`,
    ...telemetryEnvironmentArgs(exportTelemetry),
    ...(modelSocket === undefined
      ? []
      : [
          "--mount",
          `type=bind,source=${modelSocket},target=/run/harness-model.sock`,
          "--env",
          "HARNESS_EVAL_MODEL_SOCKET=/run/harness-model.sock",
        ]),
    options.image,
  ];
}
