// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HarnessError, parseJson } from "@rovinos/schemas";
import type { ModelsConfig } from "@rovinos/schemas";
import { Option } from "commander";
import type { EvalSuite } from "@rovinos/eval";
import type { CommandModule } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import {
  createVariants,
  createVariantsFromFile,
  filterSuite,
  nonnegativeNumber,
  positiveInteger,
} from "./eval-options.js";
import type { EvalOptions } from "./eval-options.js";
import {
  createDefaultExecutor,
  collectTrialEvents,
  type EvalExecutorDependencies,
  type EvalExecutorOptions,
} from "./eval-executor.js";
import { recordCassettes } from "./eval-cassettes.js";
import { writeReportFiles, writeSummaryTable } from "./eval-report-output.js";
import type { EvalPackage } from "./eval-types.js";
import { gradingExecutor } from "./eval-graders.js";

/** Dependencies replaceable by focused CLI tests; the package is loaded only on command execution. */
export interface EvalCommandDependencies extends EvalExecutorDependencies {
  readonly loadEval?: () => Promise<EvalPackage>;
}

class EvalCliError extends HarnessError {
  override readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

class EvalCommandExitError extends HarnessError {
  override readonly code: "budget_exceeded" | "eval_failed";

  constructor(code: "budget_exceeded" | "eval_failed") {
    super(code);
    this.code = code;
  }
}

interface EvalRunCommandArgs {
  readonly api: EvalPackage;
  readonly context: Parameters<CommandModule["register"]>[1];
  readonly suitePath: string;
  readonly options: EvalOptions;
  readonly dependencies: EvalCommandDependencies;
}

function executionModes(options: EvalOptions, suite: EvalSuite) {
  const cassette = options.cassette ?? (options.isolation === "docker" ? "off" : "replay");
  const isolation = options.isolation ?? (cassette === "off" ? "docker" : "inprocess");
  if (isolation === "docker") {
    if (suite.tasks.some((task) => task.graders.some((grader) => grader.type === "llm_judge"))) {
      throw new EvalCliError("eval_llm_judge_docker_unavailable");
    }
    if (cassette !== "off") {
      throw new EvalCliError(
        cassette === "replay"
          ? "eval_docker_cassette_replay_unavailable"
          : "eval_docker_cassette_record_unavailable",
      );
    }
  }
  if (cassette !== "replay" && options.live !== true) {
    throw new EvalCliError(
      isolation === "docker"
        ? "eval_docker_live_model_unavailable"
        : "eval_inprocess_live_model_unavailable",
    );
  }
  if (cassette === "replay" && options.live === true) {
    throw new EvalCliError("eval_live_cassette_conflict");
  }
  return { cassette, isolation };
}

function parseFailUnder(options: EvalOptions): number | undefined {
  const failUnder =
    options.failUnder === undefined ? undefined : nonnegativeNumber(options.failUnder);
  if (failUnder !== undefined && failUnder > 1) {
    throw new EvalCliError("usage");
  }
  return failUnder;
}

async function runTrialPlan(args: {
  readonly api: EvalPackage;
  readonly suite: EvalSuite;
  readonly variants: ReturnType<typeof createVariants>;
  readonly executor: Awaited<ReturnType<NonNullable<EvalCommandDependencies["createExecutor"]>>>;
  readonly outDir: string;
  readonly options: EvalOptions;
}) {
  const { api, suite, variants, executor, outDir, options } = args;
  return api.runEval(suite, variants, executor, {
    outDir,
    concurrency: options.concurrency === undefined ? 2 : positiveInteger(options.concurrency),
    ...(options.trials === undefined ? {} : { trials: positiveInteger(options.trials) }),
    ...(options.seed === undefined ? {} : { seed: positiveInteger(options.seed, true) }),
    ...(options.maxCostUsd === undefined
      ? {}
      : { maxCostUsd: nonnegativeNumber(options.maxCostUsd) }),
  });
}

function validateLivePlan(
  options: EvalOptions,
  models: ModelsConfig,
  suite: EvalSuite,
  variants: ReturnType<typeof createVariants>,
): void {
  if (options.live !== true) {
    return;
  }
  if (variants.some((variant) => variant.configOverrides?.models !== undefined)) {
    throw new EvalCliError("eval_live_model_override_unavailable");
  }
  const providers = new Set(models.providers.map(({ id }) => id));
  for (const variant of variants) {
    for (const task of suite.tasks) {
      const route = variant.models ?? task.models ?? models.routing.default;
      if (route.length === 0 || route.some(({ provider }) => !providers.has(provider))) {
        throw new EvalCliError("eval_live_route_unavailable");
      }
    }
  }
}

async function liveSessionFor(
  args: EvalRunCommandArgs,
  models: ModelsConfig,
  maxCalls: number,
  signal: AbortSignal,
) {
  if (args.options.live !== true) {
    return undefined;
  }
  return args.api.createLiveModelSession({
    models,
    maxCalls,
    clock: args.context.clock,
    signal,
    ...(args.context.secretResolver === undefined
      ? {}
      : { secretResolver: args.context.secretResolver }),
  });
}

async function runEvalCommand(args: EvalRunCommandArgs): Promise<ExitCode> {
  const { api, context, suitePath, options } = args;
  const config = await context.loadConfig();
  const absoluteSuitePath = resolve(suitePath);
  const suite = filterSuite(api, await api.loadSuite(absoluteSuitePath), options.filter);
  const { cassette, isolation } = executionModes(options, suite);
  const maxCalls =
    options.maxModelCalls === undefined ? 100 : positiveInteger(options.maxModelCalls);
  const failUnder = parseFailUnder(options);
  if (options.model !== undefined && options.variants !== undefined) {
    throw new EvalCliError("usage");
  }
  const variants =
    options.variants === undefined
      ? createVariants(api, options.model, cassette, config)
      : createVariantsFromFile({
          api,
          text: await readFile(resolve(options.variants), "utf8"),
          filePath: resolve(options.variants),
          cassette,
          config,
        });
  validateLivePlan(options, config.models, suite, variants);
  const outDir = resolve(
    options.out ?? join(process.cwd(), "eval-out", String(context.clock.now())),
  );
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
  };
  const liveSession = await liveSessionFor(args, config.models, maxCalls, controller.signal);
  if (liveSession !== undefined) {
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    if (isolation === "inprocess") {
      context.out.error("eval_live_inprocess_not_isolated");
    }
  }
  try {
    return await executeEvalCommand({
      ...args,
      suite,
      variants,
      outDir,
      failUnder,
      executorOptions: {
        isolation,
        cassette,
        suiteDirectory: dirname(absoluteSuitePath),
        config,
        exportTelemetry: options.exportTelemetry ?? false,
        context,
        ...(liveSession === undefined ? {} : { liveSession, signal: controller.signal }),
      },
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await liveSession?.close();
  }
}

async function executeEvalCommand(
  args: EvalRunCommandArgs & {
    readonly suite: EvalSuite;
    readonly variants: ReturnType<typeof createVariants>;
    readonly outDir: string;
    readonly failUnder: number | undefined;
    readonly executorOptions: EvalExecutorOptions;
  },
): Promise<ExitCode> {
  const {
    api,
    context,
    options,
    dependencies,
    suite,
    variants,
    outDir,
    failUnder,
    executorOptions,
  } = args;
  const baseExecutor = await (dependencies.createExecutor ?? createDefaultExecutor)(
    api,
    executorOptions,
  );
  const { executor, grades } = gradingExecutor(api, baseExecutor, executorOptions);
  const results = await runTrialPlan({ api, suite, variants, executor, outDir, options });
  const records = api.parseEvalTrialJsonl(await readFile(join(outDir, "trials.jsonl"), "utf8"));
  for (const record of records) {
    if (
      !grades.some(
        (grade) =>
          grade.taskId === record.taskId &&
          grade.variantId === record.variantId &&
          grade.trialIndex === record.trialIndex,
      )
    ) {
      grades.push({
        taskId: record.taskId,
        variantId: record.variantId,
        trialIndex: record.trialIndex,
        graders: [],
      });
    }
  }
  const eventsByTrial = await collectTrialEvents({
    api,
    suite,
    variants,
    records,
    executor,
  });
  if (executorOptions.cassette === "record") {
    await recordCassettes(executorOptions.suiteDirectory, records, eventsByTrial);
  }
  const report = api.buildEvalReport({
    trials: records,
    grades,
    invariantsEnabled: suite.invariants,
  });
  await writeReportFiles(api, outDir, report);
  writeSummaryTable(context, report);
  context.out.json(api.EvalReportSchema, report);
  if (executorOptions.liveSession?.failureCode !== undefined) {
    throw new EvalCliError(executorOptions.liveSession.failureCode);
  }
  if (executorOptions.signal?.aborted === true) {
    throw new EvalCliError("eval_live_cancelled");
  }
  if (results.some(({ status }) => status === "skipped_budget")) {
    return ExitCode.budgetExceeded;
  }
  return failUnder !== undefined && report.aggregates.some(({ passRate }) => passRate < failUnder)
    ? ExitCode.failure
    : ExitCode.ok;
}

async function runEvalAction(
  suitePath: string,
  options: EvalOptions,
  context: EvalRunCommandArgs["context"],
  dependencies: EvalCommandDependencies,
): Promise<void> {
  const api = await (dependencies.loadEval ?? (() => import("@rovinos/eval")))();
  const result = await runEvalCommand({ api, context, suitePath, options, dependencies });
  if (result !== ExitCode.ok) {
    throw new EvalCommandExitError(
      result === ExitCode.budgetExceeded ? "budget_exceeded" : "eval_failed",
    );
  }
}

/** Registers the `harness eval run` and `harness eval compare` commands. */
export function createEvalCommand(dependencies: EvalCommandDependencies = {}): CommandModule {
  return {
    name: "eval",
    register(program, context) {
      const evalCommand = program.command("eval").description("Run suites and compare reports");
      evalCommand
        .command("run <suite>")
        .description("Run an evaluation suite")
        .option("--model <provider/model[,provider/model]>", "comma-separated model variants")
        .option("--variants <file>", "load variants from a YAML file")
        .option("--trials <n>", "trials per task")
        .option("--filter <tag|taskId>", "select tasks by tag or id")
        .addOption(
          new Option("--isolation <mode>", "inprocess or docker").choices(["inprocess", "docker"]),
        )
        .addOption(
          new Option("--cassette <mode>", "record, replay, or off").choices([
            "record",
            "replay",
            "off",
          ]),
        )
        .option("--concurrency <n>", "maximum concurrent trials")
        .option("--out <dir>", "report output directory")
        .option("--seed <n>", "deterministic suite seed")
        .option("--fail-under <rate>", "fail when any pass rate is below this value")
        .option("--max-cost-usd <amount>", "stop starting trials after this cumulative cost")
        .option("--live", "permit live model calls", false)
        .option("--max-model-calls <n>", "per-run live provider request cap (default: 100)")
        .option(
          "--export-telemetry",
          "export eval telemetry through the configured pipeline",
          false,
        )
        .action((suitePath: string, options: EvalOptions) =>
          runEvalAction(suitePath, options, context, dependencies),
        );
      evalCommand
        .command("compare <report-a> <report-b>")
        .description("Compare two evaluation reports")
        .option("--variant-a <id>", "select a variant from report A")
        .option("--variant-b <id>", "select a variant from report B")
        .option("--seed <n>", "deterministic bootstrap seed", "0")
        .action(
          async (
            reportAPath: string,
            reportBPath: string,
            options: { variantA?: string; variantB?: string; seed: string },
          ) => {
            const api = await (dependencies.loadEval ?? (() => import("@rovinos/eval")))();
            const reportA = parseJson(
              api.EvalReportSchema,
              await readFile(resolve(reportAPath), "utf8"),
            );
            const reportB = parseJson(
              api.EvalReportSchema,
              await readFile(resolve(reportBPath), "utf8"),
            );
            const comparison = api.compareEvalReports(reportA, reportB, {
              ...(options.variantA === undefined ? {} : { variantA: options.variantA }),
              ...(options.variantB === undefined ? {} : { variantB: options.variantB }),
              seed: positiveInteger(options.seed, true),
            });
            context.out.print(api.renderComparisonTable(comparison));
            context.out.json(api.EvalComparisonReportSchema, comparison);
          },
        );
    },
  };
}

export const evalCommand = createEvalCommand();
