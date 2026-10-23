// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  Code,
  KeysConfigSchema,
  ModelsConfigSchema,
  PiiConfigSchema,
  PolicyConfigSchema,
  RolesConfigSchema,
  RunConfigSchema,
  StoreConfigSchema,
  VaultConfigSchema,
} from "@harness/schemas";
import type { RunBudgetsSchema } from "@harness/schemas";
import { z } from "zod";
import type { RuntimeConfig } from "@harness/core";
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

/** Executor that runs one isolated eval trial. */
export interface TrialExecutor {
  /** Runs the trial and returns only metadata about its outcome. */
  run(trial: TrialSpec): Promise<TrialResult>;
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

function configForTrial(task: EvalTask, variant: EvalVariant, keyId: string): TrialConfig {
  const budgets = trialBudgets(task, variant);
  const policyFile = variant.policyFile ?? task.policyFile;
  const contextStrategy = variant.contextStrategy ?? task.contextStrategy;
  return TrialConfigSchema.parse({
    run: RunConfigSchema.parse({ budgets }),
    roles: contextStrategy === undefined ? [] : [{ id: "eval", tools: "*", contextStrategy }],
    store: StoreConfigSchema.parse({ dialect: "sqlite" }),
    keys: KeysConfigSchema.parse({
      currentKeyId: keyId,
      keys: [{ id: keyId, secret: "env:HARNESS_EVAL_KEY" }],
    }),
    models: ModelsConfigSchema.parse({
      routing: { default: variant.models ?? task.models ?? [] },
    }),
    policy: PolicyConfigSchema.parse(policyFile === undefined ? {} : { file: "policy.yaml" }),
    pii: PiiConfigSchema.parse({}),
    vault: VaultConfigSchema.parse({ backend: "sqlite" }),
  });
}

function keyIdFor(trial: TrialSpec): string {
  return `trial_${trial.seed.toString(16)}`;
}

function secretForTrial(): string {
  return randomBytes(32).toString("base64");
}

/**
 * Creates a fresh data directory, workspace, secret reference, and config file for a trial.
 *
 * @param trial - Validated trial and variant.
 * @returns Paths and runtime configuration isolated to the trial.
 */
export async function prepareTrial(trial: TrialSpec): Promise<PreparedTrial> {
  const workDir = resolve(trial.workDir);
  if (basename(workDir) === "" || workDir === resolve(workDir, "..")) {
    throw new Error("trial_workdir_invalid");
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

  const key = secretForTrial();
  const config = configForTrial(trial.task, trial.variant, keyIdFor(trial));
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
