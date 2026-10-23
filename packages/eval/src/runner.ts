// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { EvalSuiteSchema } from "./schema.js";
import { EvalVariantSchema, TrialResultSchema, TrialSpecSchema } from "./trial.js";
import type { EvalVariant, TrialResult, TrialSpec } from "./trial.js";
import type { TrialExecutor } from "./executor.js";
import { Code } from "@harness/schemas";
import { z } from "zod";

const RunnerOptionsSchema = z
  .object({
    outDir: z.string().min(1),
    concurrency: z.number().int().positive().default(2),
    trials: z.number().int().positive().optional(),
    seed: z.number().int().nonnegative().max(0xffff_ffff).default(0),
  })
  .strict();

/** Valid options for one suite run. */
export type RunnerOptions = z.input<typeof RunnerOptionsSchema>;

/** Result of every planned task/variant/trial combination, in plan order. */
export type EvalRunResult = readonly TrialResult[];

function pathComponent(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function trialSeed(seed: number, taskId: string, variantId: string, trialIndex: number): number {
  const digest = createHash("sha256")
    .update(`${String(seed)}\u0000${taskId}\u0000${variantId}\u0000${String(trialIndex)}`)
    .digest();
  return digest.readUInt32BE(0);
}

function errorCodeFrom(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "trial_execution_failed";
}

function outputPaths(outDir: string, taskId: string, variantId: string, trialIndex: number) {
  return join(
    outDir,
    "trials",
    pathComponent(taskId),
    pathComponent(variantId),
    String(trialIndex),
  );
}

function makePlan(
  suite: ReturnType<typeof EvalSuiteSchema.parse>,
  variants: readonly EvalVariant[],
  options: z.output<typeof RunnerOptionsSchema>,
): TrialSpec[] {
  const outDir = resolve(options.outDir);
  const trials: TrialSpec[] = [];
  for (const task of suite.tasks) {
    for (const variant of variants) {
      const count = options.trials ?? task.trials ?? 1;
      for (let trialIndex = 0; trialIndex < count; trialIndex += 1) {
        trials.push(
          TrialSpecSchema.parse({
            suite,
            task,
            variantId: variant.id,
            variant,
            trialIndex,
            seed: trialSeed(options.seed, task.id, variant.id, trialIndex),
            workDir: outputPaths(outDir, task.id, variant.id, trialIndex),
          }),
        );
      }
    }
  }
  return trials;
}

/**
 * Runs all task/variant/trial combinations with bounded concurrency.
 *
 * Each executor owns setup of its isolated trial resources. Results are appended
 * to `trials.jsonl` as they settle; the returned list follows plan order.
 *
 * @param suite - Validated eval suite.
 * @param variants - Variants to apply to each task.
 * @param executor - In-process or Docker executor.
 * @param options - Output directory, trial count, seed, and concurrency.
 * @returns Results ordered by task, variant, and trial index.
 */
export async function runEval(
  suite: unknown,
  variants: readonly unknown[],
  executor: TrialExecutor,
  options: RunnerOptions,
): Promise<EvalRunResult> {
  const parsedSuite = EvalSuiteSchema.parse(suite);
  const parsedVariants = variants.map((variant) => EvalVariantSchema.parse(variant));
  if (new Set(parsedVariants.map(({ id }) => id)).size !== parsedVariants.length) {
    throw new Error("eval_variant_id_duplicate");
  }
  const parsedOptions = RunnerOptionsSchema.parse(options);
  const outDir = resolve(parsedOptions.outDir);
  const trials = makePlan(parsedSuite, parsedVariants, parsedOptions);
  const trialsRoot = join(outDir, "trials");
  const jsonlPath = join(outDir, "trials.jsonl");
  await mkdir(trialsRoot, { recursive: true });

  const root = resolve(trialsRoot);
  await Promise.all(
    trials.map(async (trial) => {
      const workDir = resolve(trial.workDir);
      if (!workDir.startsWith(`${root}${sep}`)) {
        throw new Error("trial_workdir_outside_output");
      }
      await rm(workDir, { recursive: true, force: true });
    }),
  );

  const results = new Map<number, TrialResult>();
  const output = await open(jsonlPath, "w");
  let writeChain = Promise.resolve();
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const trial = trials[index];
      if (trial === undefined) {
        return;
      }
      const start = performance.now();
      let result: TrialResult;
      try {
        result = TrialResultSchema.parse(await executor.run(trial));
      } catch (error) {
        result = TrialResultSchema.parse({
          status: "error",
          dbPath: join(trial.workDir, "data", "harness.db"),
          workspaceDir: join(trial.workDir, "workspace"),
          durationMs: Math.max(0, Math.floor(performance.now() - start)),
          usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
          exitCode: 1,
          errorCode: errorCodeFrom(error),
        });
      }
      results.set(index, result);
      writeChain = writeChain.then(() => output.appendFile(`${JSON.stringify(result)}\n`, "utf8"));
      await writeChain;
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(parsedOptions.concurrency, trials.length) }, () => worker()),
    );
    await writeChain;
  } finally {
    await output.close();
  }
  return trials.map((_, index) => {
    const result = results.get(index);
    if (result === undefined) {
      throw new Error("eval_result_missing");
    }
    return result;
  });
}
