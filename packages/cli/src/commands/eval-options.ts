// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from "@rovinos/config";
import { Code, HarnessError } from "@rovinos/schemas";
import { CommanderError } from "commander";
import type { EvalVariant, EvalSuite } from "@rovinos/eval";

type EvalPackage = typeof import("@rovinos/eval");

class EvalOptionError extends HarnessError {
  override readonly code: "usage" | "eval_filter_empty";

  constructor(code: "usage" | "eval_filter_empty") {
    super(code);
    this.code = code;
  }
}

export interface EvalOptions {
  readonly model?: string;
  readonly trials?: string;
  readonly filter?: string;
  readonly isolation?: "inprocess" | "docker";
  readonly cassette?: "record" | "replay" | "off";
  readonly concurrency?: string;
  readonly out?: string;
  readonly seed?: string;
  readonly failUnder?: string;
  readonly maxCostUsd?: string;
  readonly exportTelemetry?: boolean;
}

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

export function nonnegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CommanderError(2, "commander.invalidArgument", "invalid numeric option");
  }
  return parsed;
}

export function createVariants(
  api: EvalPackage,
  modelOption: string | undefined,
  cassette: "record" | "replay" | "off",
  config: HarnessConfig,
): EvalVariant[] {
  const defaultProvider = config.models?.providers[0]?.id ?? "openai";
  if (modelOption === undefined) {
    return [{ id: "default", ...(cassette === "off" ? {} : { cassetteMode: cassette }) }];
  }
  const models = modelOption.split(",").map((value) => {
    const parts = value.split("/");
    const provider = parts.length === 2 ? parts[0] : defaultProvider;
    const model = parts.length === 2 ? parts[1] : parts[0];
    if (provider === undefined || model === undefined || provider.length === 0 || model.length === 0) {
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
