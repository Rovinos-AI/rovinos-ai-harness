// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from "@rovinos/config";
import { HarnessError } from "@rovinos/schemas";
import type { CommandModule } from "../command.js";
import type { EvalSuite, EvalVariant, TrialExecutor, createLiveModelSession } from "@rovinos/eval";
import type { Event } from "@rovinos/schemas";
import cliPackage from "../../package.json" with { type: "json" };
import { resolve } from "node:path";
import type { EvalPackage } from "./eval-types.js";
import { cassetteModelFactory } from "./eval-cassettes.js";

/** Runtime configuration passed to an eval executor. */
export interface EvalExecutorOptions {
  readonly isolation: "inprocess" | "docker";
  readonly cassette: "record" | "replay" | "off";
  readonly suiteDirectory: string;
  readonly config: HarnessConfig;
  readonly exportTelemetry: boolean;
  readonly context: Parameters<CommandModule["register"]>[1];
  readonly liveSession?: Awaited<ReturnType<typeof createLiveModelSession>>;
  readonly signal?: AbortSignal;
}

/** Optional executor factory for tests and alternate execution environments. */
export interface EvalExecutorDependencies {
  readonly createExecutor?: (
    api: EvalPackage,
    options: EvalExecutorOptions,
  ) => TrialExecutor | Promise<TrialExecutor>;
}

class LiveDockerSetupError extends HarnessError {
  readonly code: "eval_live_docker_user_unavailable" | "eval_live_docker_host_unavailable";

  constructor(code: LiveDockerSetupError["code"]) {
    super(code);
    this.code = code;
  }
}

function liveDockerUser(): string {
  const host = process.env.DOCKER_HOST;
  const context = process.env.DOCKER_CONTEXT;
  if (
    process.platform !== "linux" ||
    (host !== undefined && !host.startsWith("unix:///")) ||
    (context !== undefined && context !== "default")
  ) {
    throw new LiveDockerSetupError("eval_live_docker_host_unavailable");
  }
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid < 1 || gid < 1) {
    throw new LiveDockerSetupError("eval_live_docker_user_unavailable");
  }
  return `${String(uid)}:${String(gid)}`;
}

/** Collects tokenized run events for each executed trial. */
export async function collectTrialEvents(options: {
  readonly api: EvalPackage;
  readonly suite: EvalSuite;
  readonly variants: readonly EvalVariant[];
  readonly records: ReturnType<EvalPackage["parseEvalTrialJsonl"]>;
  readonly executor: TrialExecutor;
}): Promise<Map<string, readonly Event[]>> {
  const eventsByTrial = new Map<string, readonly Event[]>();
  for (const record of options.records) {
    if (record.result.status === "skipped_budget") {
      continue;
    }
    const task = options.suite.tasks.find((candidate) => candidate.id === record.taskId);
    const variant = options.variants.find((candidate) => candidate.id === record.variantId);
    if (task === undefined || variant === undefined) {
      continue;
    }
    const trial = options.api.TrialSpecSchema.parse({
      suite: options.suite,
      task,
      variantId: record.variantId,
      variant,
      trialIndex: record.trialIndex,
      seed: record.seed,
      workDir: resolve(record.result.dbPath, "../.."),
    });
    const events = await options.executor.eventsFor?.(trial);
    eventsByTrial.set(
      `${record.taskId}\u0000${record.variantId}\u0000${String(record.trialIndex)}`,
      events ?? [],
    );
  }
  return eventsByTrial;
}

/** Creates the configured in-process or Docker trial executor. */
export function createDefaultExecutor(
  api: EvalPackage,
  options: EvalExecutorOptions,
): TrialExecutor {
  const session = options.liveSession;
  const liveModel =
    session === undefined
      ? undefined
      : (trial: Parameters<TrialExecutor["run"]>[0]) =>
          session.modelFor({
            ...options.config.models.routing,
            default:
              trial.variant.models ?? trial.task.models ?? options.config.models.routing.default,
          });
  const dependencies = {
    exportTelemetry: options.exportTelemetry,
    ...(session === undefined ? {} : { clock: options.context.clock }),
    models:
      session === undefined ? options.config.models : { ...options.config.models, providers: [] },
    ...(options.context.secretResolver === undefined
      ? {}
      : { secretResolver: options.context.secretResolver }),
    ...(liveModel === undefined
      ? {}
      : {
          liveModel: {
            model: liveModel,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        }),
  };
  if (options.isolation === "docker") {
    const image =
      process.env.HARNESS_EVAL_IMAGE ?? `ghcr.io/rovinos-ai/harness:v${cliPackage.version}`;
    return new api.DockerExecutor(
      { image, ...(liveModel === undefined ? {} : { user: liveDockerUser() }) },
      dependencies,
    );
  }
  const model =
    liveModel ??
    (options.cassette === "replay" ? cassetteModelFactory(options.suiteDirectory) : undefined);
  return new api.InProcessExecutor({
    ...dependencies,
    ...(model === undefined ? {} : { model }),
  });
}
