// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HarnessError } from "@rovinos/schemas";
import { Option } from "commander";
import type { EvalSuite } from "@rovinos/eval";
import type { CommandModule } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createVariants, filterSuite, nonnegativeNumber, positiveInteger } from "./eval-options.js";
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
    throw new EvalCliError(
      cassette === "replay"
        ? "eval_docker_cassette_replay_unavailable"
        : "eval_docker_live_model_unavailable",
    );
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

async function runEvalCommand(args: EvalRunCommandArgs): Promise<ExitCode> {
  const { api, context, suitePath, options, dependencies } = args;
  const config = await context.loadConfig();
  const absoluteSuitePath = resolve(suitePath);
  const suite = filterSuite(api, await api.loadSuite(absoluteSuitePath), options.filter);
  const { cassette, isolation } = executionModes(options, suite);
  const failUnder = parseFailUnder(options);
  const variants = createVariants(api, options.model, cassette, config);
  const outDir = resolve(
    options.out ?? join(process.cwd(), "eval-out", String(context.clock.now())),
  );
  const executorOptions: EvalExecutorOptions = {
    isolation,
    cassette,
    suiteDirectory: dirname(absoluteSuitePath),
    config,
    exportTelemetry: options.exportTelemetry ?? false,
    context,
  };
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
  if (cassette === "record") {
    await recordCassettes(dirname(absoluteSuitePath), records, eventsByTrial);
  }
  const report = api.buildEvalReport({ trials: records, grades });
  await writeReportFiles(api, outDir, report);
  writeSummaryTable(context, report);
  context.out.json(api.EvalReportSchema, report);
  if (results.some(({ status }) => status === "skipped_budget")) {
    return ExitCode.budgetExceeded;
  }
  return failUnder !== undefined && report.aggregates.some(({ passRate }) => passRate < failUnder)
    ? ExitCode.failure
    : ExitCode.ok;
}

/** Registers the `harness eval run` command group. */
export function createEvalCommand(dependencies: EvalCommandDependencies = {}): CommandModule {
  return {
    name: "eval",
    register(program, context) {
      program
        .command("eval")
        .description("Run evaluation suites")
        .command("run <suite>")
        .description("Run an evaluation suite")
        .option("--model <provider/model[,provider/model]>", "comma-separated model variants")
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
        .option(
          "--export-telemetry",
          "export eval telemetry through the configured pipeline",
          false,
        )
        .action(async (suitePath: string, options: EvalOptions) => {
          const api = await (dependencies.loadEval ?? (() => import("@rovinos/eval")))();
          const result = await runEvalCommand({
            api,
            context,
            suitePath,
            options,
            dependencies,
          });
          if (result !== ExitCode.ok) {
            throw new EvalCommandExitError(
              result === ExitCode.budgetExceeded ? "budget_exceeded" : "eval_failed",
            );
          }
        });
    },
  };
}

export const evalCommand = createEvalCommand();
