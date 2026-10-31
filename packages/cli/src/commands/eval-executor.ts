// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from "@rovinos/config";
import { HARNESS_VERSION } from "@rovinos/schemas";
import type { CommandModule } from "../command.js";
import type { EvalSuite, EvalVariant, TrialExecutor } from "@rovinos/eval";
import type { Event } from "@rovinos/schemas";
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
}

/** Optional executor factory for tests and alternate execution environments. */
export interface EvalExecutorDependencies {
  readonly createExecutor?: (
    api: EvalPackage,
    options: EvalExecutorOptions,
  ) => TrialExecutor | Promise<TrialExecutor>;
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
  const dependencies = {
    exportTelemetry: options.exportTelemetry,
    models: options.config.models,
    ...(options.context.secretResolver === undefined
      ? {}
      : { secretResolver: options.context.secretResolver }),
  };
  if (options.isolation === "docker") {
    const image = process.env.HARNESS_EVAL_IMAGE ?? `ghcr.io/rovinos-ai/harness:${HARNESS_VERSION}`;
    return new api.DockerExecutor({ image }, dependencies);
  }
  return new api.InProcessExecutor({
    ...dependencies,
    ...(options.cassette === "replay"
      ? { model: cassetteModelFactory(options.suiteDirectory) }
      : {}),
  });
}
