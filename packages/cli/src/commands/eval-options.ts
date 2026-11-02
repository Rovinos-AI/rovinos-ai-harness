// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema, type HarnessConfig } from "@rovinos/config";
import { Code, HarnessError, parseYaml } from "@rovinos/schemas";
import { CommanderError } from "commander";
import { dirname, resolve } from "node:path";
import type { EvalSuite, EvalVariant } from "@rovinos/eval";
import type { EvalPackage } from "./eval-types.js";

class EvalOptionError extends HarnessError {
  override readonly code: "usage" | "eval_filter_empty";

  constructor(code: "usage" | "eval_filter_empty") {
    super(code);
    this.code = code;
  }
}

/** Values parsed by Commander for `harness eval run`. */
export interface EvalOptions {
  readonly model?: string;
  readonly trials?: string;
  readonly filter?: string;
  readonly isolation?: "inprocess" | "docker";
  readonly cassette?: "record" | "replay" | "off";
  readonly concurrency?: string;
  readonly out?: string;
  readonly seed?: string;
  readonly variants?: string;
  readonly failUnder?: string;
  readonly maxCostUsd?: string;
  readonly exportTelemetry?: boolean;
}

/** Parses a positive integer command-line value. */
export function positiveInteger(value: string, allowZero = false): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (allowZero ? parsed < 0 || parsed > 0xffff_ffff : parsed < 1)
  ) {
    throw new CommanderError(2, "commander.invalidArgument", "invalid numeric option");
  }
  return parsed;
}

/** Parses a non-negative numeric command-line value. */
export function nonnegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CommanderError(2, "commander.invalidArgument", "invalid numeric option");
  }
  return parsed;
}

/** Creates variants from the model option and configured default provider. */
export function createVariants(
  api: EvalPackage,
  modelOption: string | undefined,
  cassette: "record" | "replay" | "off",
  config: HarnessConfig,
): EvalVariant[] {
  const defaultProvider = config.models.providers[0]?.id ?? "openai";
  if (modelOption === undefined) {
    return [{ id: "default", ...(cassette === "off" ? {} : { cassetteMode: cassette }) }];
  }
  const models = modelOption.split(",").map((value) => {
    const parts = value.split("/");
    const provider = parts.length === 2 ? parts[0] : defaultProvider;
    const model = parts.length === 2 ? parts[1] : parts[0];
    if (
      provider === undefined ||
      model === undefined ||
      provider.length === 0 ||
      model.length === 0
    ) {
      throw new EvalOptionError("usage");
    }
    try {
      return { provider: Code.parse(provider), model: Code.parse(model) };
    } catch {
      throw new EvalOptionError("usage");
    }
  });
  return models.map((model, index) =>
    api.EvalVariantSchema.parse({
      id: `model_${String(index + 1)}`,
      models: [model],
      ...(cassette === "off" ? {} : { cassetteMode: cassette }),
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) {
    return override;
  }
  const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
  return Object.fromEntries(
    [...keys].map((key) => [
      key,
      key in override ? deepMerge(base[key], override[key]) : base[key],
    ]),
  );
}

/** Validates a variants YAML document and converts its routes to runner variants. */
export function createVariantsFromFile(args: {
  readonly api: EvalPackage;
  readonly text: string;
  readonly filePath: string;
  readonly cassette: "record" | "replay" | "off";
  readonly config: HarnessConfig;
}): EvalVariant[] {
  const { api, text, filePath, cassette, config } = args;
  const entries = api.parseEvalVariants(parseYaml(api.EvalVariantsFileSchema, text));
  return entries.map((variant) => {
    if (variant.configOverrides !== undefined) {
      HarnessConfigSchema.parse(deepMerge(config, variant.configOverrides));
    }
    return api.EvalVariantSchema.parse({
      ...variant,
      ...(variant.policyFile === undefined
        ? {}
        : { policyFile: resolve(dirname(filePath), variant.policyFile) }),
      ...(cassette === "off" ? {} : { cassetteMode: cassette }),
    });
  });
}

/** Returns a suite containing only tasks selected by the optional filter. */
export function filterSuite(
  api: EvalPackage,
  suite: EvalSuite,
  filter: string | undefined,
): EvalSuite {
  if (filter === undefined) {
    return suite;
  }
  const tasks = suite.tasks.filter((task) => task.id === filter || task.tags.includes(filter));
  if (tasks.length === 0) {
    throw new EvalOptionError("eval_filter_empty");
  }
  return api.EvalSuiteSchema.parse({ ...suite, tasks });
}
