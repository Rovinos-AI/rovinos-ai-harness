// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  Code,
  HarnessError,
  KeysConfigSchema,
  ModelsConfigSchema,
  PiiConfigSchema,
  PolicyConfigSchema,
  RolesConfigSchema,
  RunConfigSchema,
  StoreConfigSchema,
  VaultConfigSchema,
} from "@rovinos/schemas";
import type { Event, ModelsConfig, RunBudgetsSchema, SecretRef } from "@rovinos/schemas";
import { z } from "zod";
import type { Clock, RuntimeConfig } from "@rovinos/core";
import type { GradeContext } from "./graders/types.js";
import type { EvalTask } from "./schema.js";
import { EvalCassetteModeSchema } from "./trial.js";
import type { EvalVariant, TrialResult, TrialSpec } from "./trial.js";

/** Variant-specific eval metadata not consumed by the harness runtime config. */
export const TrialEvalOptionsSchema = z
  .object({
    variantId: Code,
    cassetteMode: EvalCassetteModeSchema.optional(),
  })
  .strict();

/** Inferred eval-only options persisted alongside the harness configuration. */
export type TrialEvalOptions = z.infer<typeof TrialEvalOptionsSchema>;

/** Generated subset of the harness config used by one eval trial. */
export const TrialConfigSchema = z
  .object({
    run: RunConfigSchema,
    roles: RolesConfigSchema,
    store: StoreConfigSchema,
    keys: KeysConfigSchema,
    models: ModelsConfigSchema,
    policy: PolicyConfigSchema,
    pii: PiiConfigSchema,
    vault: VaultConfigSchema,
  })
  .strict();

/** Inferred configuration written into each isolated trial directory. */
export type TrialConfig = z.infer<typeof TrialConfigSchema>;

/** Prepared per-trial resources; secret material is never written to disk. */
export interface PreparedTrial {
  readonly config: TrialConfig;
  readonly runtimeConfig: RuntimeConfig;
  readonly configPath: string;
  readonly evalOptionsPath: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly workspaceDir: string;
  readonly policyPath?: string;
  readonly key: string;
}

/** Injectable time and cryptographic randomness used for trial resources. */
export interface TrialExecutionDependencies {
  readonly clock?: Clock;
  readonly randomBytes?: (size: number) => Uint8Array;
  /** Preserve a caller-configured external pipeline; defaults to memory-only eval telemetry. */
  readonly exportTelemetry?: boolean;
  /** Provider configuration and secret resolver used for live model evaluations. */
  readonly models?: ModelsConfig;
  readonly secretResolver?: {
    resolve(ref: SecretRef, signal?: AbortSignal): Promise<{ reveal(): string }>;
  };
}

/** System clock used for elapsed-time measurements. */
export const systemClock: Clock = Object.freeze({ now: () => Date.now() });

/** Cryptographic random source used for fresh per-trial key material. */
export const systemRandomBytes = (size: number): Uint8Array => randomBytes(size);

class TrialSetupError extends HarnessError {
  readonly code: "trial_workdir_invalid" | "trial_random_source_invalid";

  constructor(code: "trial_workdir_invalid" | "trial_random_source_invalid") {
    super(code);
    this.code = code;
  }
}

/** Executor that runs one isolated eval trial. */
export interface TrialExecutor {
  /** Runs the trial and returns only metadata about its outcome. */
  run(trial: TrialSpec): Promise<TrialResult>;
  /** Executes grading before releasing the isolated runtime resources. */
  runWithContext?(
    trial: TrialSpec,
    finish: (context: GradeContext) => Promise<TrialResult>,
  ): Promise<TrialResult>;
  /** Returns tokenized events kept in memory for grading and cassette recording. */
  eventsFor?(trial: TrialSpec): Promise<readonly Event[]> | readonly Event[];
}

function runtimeConfig(config: TrialConfig): RuntimeConfig {
  return {
    run: config.run,
    roles: config.roles,
    store: config.store,
    keys: config.keys,
    models: config.models,
    policy: config.policy,
    pii: config.pii,
    vault: config.vault,
  };
}

function trialBudgets(task: EvalTask, variant: EvalVariant): z.input<typeof RunBudgetsSchema> {
  return { ...task.budgets, ...variant.budgets };
}

function configForTrial(
  task: EvalTask,
  variant: EvalVariant,
  keyId: string,
  models?: ModelsConfig,
): TrialConfig {
  const budgets = trialBudgets(task, variant);
  const policyFile = variant.policyFile ?? task.policyFile;
  const contextStrategy = variant.contextStrategy ?? task.contextStrategy;
  const parsedModels = ModelsConfigSchema.parse(models ?? {});
  return TrialConfigSchema.parse({
    run: RunConfigSchema.parse({ budgets }),
    roles: contextStrategy === undefined ? [] : [{ id: "eval", tools: "*", contextStrategy }],
    store: StoreConfigSchema.parse({ dialect: "sqlite" }),
    keys: KeysConfigSchema.parse({
      currentKeyId: keyId,
      keys: [{ id: keyId, secret: "env:HARNESS_EVAL_KEY" }],
    }),
    models: ModelsConfigSchema.parse({
      ...parsedModels,
      routing: {
        ...parsedModels.routing,
        default: variant.models ?? task.models ?? parsedModels.routing.default,
      },
    }),
    policy: PolicyConfigSchema.parse(policyFile === undefined ? {} : { file: "policy.yaml" }),
    pii: PiiConfigSchema.parse({}),
    vault: VaultConfigSchema.parse({ backend: "sqlite" }),
  });
}

function keyIdFor(trial: TrialSpec): string {
  return `trial_${trial.seed.toString(16)}`;
}

function secretForTrial(randomSource: (size: number) => Uint8Array): string {
  const bytes = randomSource(32);
  if (bytes.byteLength !== 32) {
    throw new TrialSetupError("trial_random_source_invalid");
  }
  return Buffer.from(bytes).toString("base64");
}

/**
 * Creates a fresh data directory, workspace, secret reference, and config file for a trial.
 *
 * @param trial - Validated trial and variant.
 * @returns Paths and runtime configuration isolated to the trial.
 */
export async function prepareTrial(
  trial: TrialSpec,
  dependencies: TrialExecutionDependencies = {},
): Promise<PreparedTrial> {
  const workDir = resolve(trial.workDir);
  if (basename(workDir) === "" || workDir === resolve(workDir, "..")) {
    throw new TrialSetupError("trial_workdir_invalid");
  }
  await mkdir(dirname(workDir), { recursive: true });
  await mkdir(workDir, { recursive: false });
  const dataDir = join(workDir, "data");
  const workspaceDir = join(workDir, "workspace");
  await mkdir(dataDir, { recursive: false });
  await mkdir(workspaceDir, { recursive: false });

  if (trial.task.workspace !== undefined) {
    await cp(trial.task.workspace.fixtureDir, workspaceDir, { recursive: true });
  }

  let policyPath: string | undefined;
  const policySource = trial.variant.policyFile ?? trial.task.policyFile;
  if (policySource !== undefined) {
    policyPath = join(workDir, "policy.yaml");
    await cp(policySource, policyPath);
  }

  const key = secretForTrial(dependencies.randomBytes ?? systemRandomBytes);
  const config = configForTrial(trial.task, trial.variant, keyIdFor(trial), dependencies.models);
  const configPath = join(workDir, "harness.config.json");
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", flag: "wx" });
  const evalOptionsPath = join(workDir, "eval.options.json");
  const evalOptions = TrialEvalOptionsSchema.parse({
    variantId: trial.variant.id,
    ...(trial.variant.cassetteMode === undefined
      ? {}
      : { cassetteMode: trial.variant.cassetteMode }),
  });
  await writeFile(evalOptionsPath, `${JSON.stringify(evalOptions)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  return {
    config,
    runtimeConfig: runtimeConfig(config),
    configPath,
    evalOptionsPath,
    dataDir,
    dbPath: join(dataDir, "harness.db"),
    workspaceDir,
    ...(policyPath === undefined ? {} : { policyPath }),
    key,
  };
}
