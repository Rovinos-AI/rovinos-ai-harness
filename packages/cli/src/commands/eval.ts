// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { HarnessConfig } from "@rovinos/config";
import { HARNESS_VERSION, Code, HarnessError } from "@rovinos/schemas";
import type { Event } from "@rovinos/schemas";
import type { ModelPort } from "@rovinos/core";
import { CommanderError } from "commander";
import { z } from "zod";
import type {
  EvalReport,
  EvalSuite,
  EvalVariant,
  TrialExecutor,
  TrialSpec,
} from "@rovinos/eval";
import type { CommandModule } from "../command.js";
import { ExitCode } from "../exit-codes.js";

type EvalPackage = typeof import("@rovinos/eval");
type Isolation = "inprocess" | "docker";
type CassetteMode = "record" | "replay" | "off";

interface EvalOptions {
  readonly model?: string;
  readonly trials?: string;
  readonly filter?: string;
  readonly isolation?: Isolation;
  readonly cassette?: CassetteMode;
  readonly concurrency?: string;
  readonly out?: string;
  readonly seed?: string;
  readonly failUnder?: string;
  readonly maxCostUsd?: string;
  readonly exportTelemetry?: boolean;
}

interface EvalExecutorOptions {
  readonly isolation: Isolation;
  readonly cassette: CassetteMode;
  readonly suiteDirectory: string;
  readonly config: HarnessConfig;
  readonly exportTelemetry: boolean;
  readonly context: Parameters<CommandModule["register"]>[1];
}

/** Dependencies replaceable by focused CLI tests; the package is loaded only on command execution. */
export interface EvalCommandDependencies {
  readonly loadEval?: () => Promise<EvalPackage>;
  readonly createExecutor?: (
    api: EvalPackage,
    options: EvalExecutorOptions,
  ) => TrialExecutor | Promise<TrialExecutor>;
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

function positiveInteger(value: string, allowZero = false): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (allowZero ? parsed < 0 || parsed > 0xffff_ffff : parsed < 1)
  ) {
    throw new CommanderError(2, "commander.invalidArgument", "invalid numeric option");
  }
  return parsed;
}

function nonnegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CommanderError(2, "commander.invalidArgument", "invalid numeric option");
  }
  return parsed;
}

function createVariants(
  api: EvalPackage,
  modelOption: string | undefined,
  cassette: CassetteMode,
  config: HarnessConfig,
): EvalVariant[] {
  const defaultProvider = config.models?.providers[0]?.id ?? "openai";
  if (modelOption === undefined) {
    return [
      {
        id: "default",
        ...(cassette === "off" ? {} : { cassetteMode: cassette }),
      },
    ];
  }
  const models = modelOption.split(",").map((value) => {
    const parts = value.split("/");
    const provider = parts.length === 2 ? parts[0] : defaultProvider;
    const model = parts.length === 2 ? parts[1] : parts[0];
    if (provider === undefined || model === undefined || provider.length === 0 || model.length === 0) {
      throw new EvalCliError("usage");
    }
    try {
      return { provider: Code.parse(provider), model: Code.parse(model) };
    } catch {
      throw new EvalCliError("usage");
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

function filterSuite(api: EvalPackage, suite: EvalSuite, filter: string | undefined): EvalSuite {
  if (filter === undefined) {
    return suite;
  }
  const tasks = suite.tasks.filter((task) => task.id === filter || task.tags.includes(filter));
  if (tasks.length === 0) {
    throw new EvalCliError("eval_filter_empty");
  }
  return api.EvalSuiteSchema.parse({ ...suite, tasks });
}

function validateGraders(suite: EvalSuite): void {
  if (
    suite.tasks.some((task) =>
      task.graders.some((grader) => grader.type === "test_command" || grader.type === "llm_judge"),
    )
  ) {
    throw new EvalCliError("eval_grader_context_unavailable");
  }
}

function cassetteModelFactory(suiteDirectory: string): (trial: TrialSpec) => ModelPort {
  return (trial) => {
    const path = join(
      suiteDirectory,
      "cassettes",
      trial.task.id,
      `${trial.variantId}.json`,
    );
    return {
      async complete(request) {
        const { CassetteMissError, FileCassetteStore } = await import("@rovinos/models");
        const { modelRequestParametersHash, storedModelRequestHash } = await import(
          "@rovinos/schemas/request-signature"
        );
        const hash = storedModelRequestHash(request.messages, modelRequestParametersHash(request));
        const store = new FileCassetteStore(path);
        const response = await store.get(hash, request);
        if (response === undefined) {
          throw new CassetteMissError(hash);
        }
        return {
          ...response,
          provider: request.model.provider,
          model: request.model.model,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        };
      },
    };
  };
}

function createDefaultExecutor(api: EvalPackage, options: EvalExecutorOptions): TrialExecutor {
  const dependencies = {
    exportTelemetry: options.exportTelemetry,
    ...(options.config.models === undefined ? {} : { models: options.config.models }),
    ...(options.context.secretResolver === undefined
      ? {}
      : { secretResolver: options.context.secretResolver }),
  };
  if (options.isolation === "docker") {
    const image =
      process.env.HARNESS_EVAL_IMAGE ?? `ghcr.io/rovinos-ai/harness:${HARNESS_VERSION}`;
    return new api.DockerExecutor({ image }, dependencies);
  }
  return new api.InProcessExecutor({
    ...dependencies,
    ...(options.cassette === "replay"
      ? { model: cassetteModelFactory(options.suiteDirectory) }
      : {}),
  });
}

async function writeReportFiles(
  api: EvalPackage,
  outDir: string,
  report: EvalReport,
): Promise<void> {
  await Promise.all([
    writeFile(join(outDir, "eval-report.json"), api.serializeEvalReport(report), "utf8"),
    writeFile(join(outDir, "eval-report.md"), api.renderMarkdownReport(report), "utf8"),
    writeFile(join(outDir, "junit.xml"), api.renderJunitReport(report), "utf8"),
  ]);
}

async function gradeRecords(
  api: EvalPackage,
  suite: EvalSuite,
  records: ReturnType<EvalPackage["parseEvalTrialJsonl"]>,
  eventsByTrial: ReadonlyMap<string, readonly Event[]>,
) {
  return Promise.all(
    records.map(async (record) => {
      const task = suite.tasks.find((candidate) => candidate.id === record.taskId);
      if (task === undefined) {
        return undefined;
      }
      if (record.result.status === "skipped_budget") {
        return {
          taskId: record.taskId,
          variantId: record.variantId,
          trialIndex: record.trialIndex,
          graders: [],
        };
      }
      const graders = await Promise.all(
        task.graders.map(async (spec) => {
          const events =
            eventsByTrial.get(
              `${record.taskId}\u0000${record.variantId}\u0000${String(record.trialIndex)}`,
            ) ?? [];
          if (spec.type === "file_diff") {
            try {
              return await api.createFileDiffGrader(spec).grade({ result: record.result });
            } catch {
              return api.GradeResultSchema.parse({
                graderId: "file_diff",
                pass: false,
                score: 0,
                codes: ["grader_execution_failed"],
              });
            }
          }
          if (spec.type === "no_canary_leak" && (task.canaries?.length ?? 0) > 0) {
            try {
              return await api
                .createNoCanaryLeakGrader({
                  canaries: task.canaries ?? [],
                  ...(task.workspace === undefined ? {} : { fixtureDir: task.workspace.fixtureDir }),
                })
                .grade({ result: record.result });
            } catch {
              return api.GradeResultSchema.parse({
                graderId: "no_canary_leak",
                pass: false,
                score: 0,
                codes: ["grader_execution_failed"],
              });
            }
          }
          if (spec.type === "test_command") {
            return api.createTestCommandGrader(spec).grade({ result: record.result });
          }
          if (spec.type === "schema_valid") {
            return api.createSchemaValidGrader(spec).grade({ result: record.result, events });
          }
          if (spec.type === "trajectory") {
            const trajectory = api.evaluateTrajectory(events, spec.assertions, {
              canaries: task.canaries,
            });
            const codes = trajectory.results.filter((item) => !item.pass).map(({ code }) => code);
            return api.GradeResultSchema.parse({
              graderId: "trajectory",
              pass: trajectory.pass,
              score: trajectory.pass ? 1 : 0,
              codes,
            });
          }
          return api.GradeResultSchema.parse({
            graderId: spec.type,
            pass: false,
            score: 0,
            codes: [spec.type === "no_canary_leak" ? "canaries_missing" : "grader_context_unavailable"],
          });
        }),
      );
      return {
        taskId: record.taskId,
        variantId: record.variantId,
        trialIndex: record.trialIndex,
        graders,
      };
    }),
  ).then((grades) => grades.filter((grade) => grade !== undefined));
}

function trialIdentity(record: {
  readonly taskId: string;
  readonly variantId: string;
  readonly trialIndex: number;
}): string {
  return `${record.taskId}\u0000${record.variantId}\u0000${String(record.trialIndex)}`;
}

async function collectTrialEvents(
  api: EvalPackage,
  suite: EvalSuite,
  variants: readonly EvalVariant[],
  records: ReturnType<EvalPackage["parseEvalTrialJsonl"]>,
  executor: TrialExecutor,
): Promise<Map<string, Awaited<ReturnType<NonNullable<TrialExecutor["eventsFor"]>>>>> {
  const eventsByTrial = new Map<
    string,
    Awaited<ReturnType<NonNullable<TrialExecutor["eventsFor"]>>>
  >();
  for (const record of records) {
    if (record.result.status === "skipped_budget") {
      continue;
    }
    const task = suite.tasks.find((candidate) => candidate.id === record.taskId);
    const variant = variants.find((candidate) => candidate.id === record.variantId);
    if (task === undefined || variant === undefined) {
      continue;
    }
    const trial = api.TrialSpecSchema.parse({
      suite,
      task,
      variantId: record.variantId,
      variant,
      trialIndex: record.trialIndex,
      seed: record.seed,
      workDir: resolve(record.result.dbPath, "../.."),
    });
    const events = await executor.eventsFor?.(trial);
    eventsByTrial.set(trialIdentity(record), events ?? []);
  }
  return eventsByTrial;
}

async function recordCassettes(
  suiteDirectory: string,
  records: ReturnType<EvalPackage["parseEvalTrialJsonl"]>,
  eventsByTrial: ReadonlyMap<string, readonly Event[]>,
): Promise<void> {
  const { FileCassetteStore } = await import("@rovinos/models");
  const stores = new Map<string, InstanceType<typeof FileCassetteStore>>();
  for (const record of records) {
    if (record.result.status === "skipped_budget") {
      continue;
    }
    const taskEvents = eventsByTrial.get(trialIdentity(record)) ?? [];
    const responses = new Map(
      taskEvents
        .filter((event) => event.type === "model_response")
        .map((event) => [event.requestId, event]),
    );
    const path = join(
      suiteDirectory,
      "cassettes",
      record.taskId,
      `${record.variantId}.json`,
    );
    let store = stores.get(path);
    if (store === undefined) {
      store = new FileCassetteStore(path);
      stores.set(path, store);
    }
    for (const request of taskEvents) {
      if (request.type !== "model_request" || request.requestHash === undefined) {
        continue;
      }
      const response = responses.get(request.requestId);
      if (response === undefined) {
        continue;
      }
      await store.set({
        hash: request.requestHash,
        response: {
          parts: response.content,
          usage: {
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            ...(response.cacheReadTokens === undefined
              ? {}
              : { cacheReadTokens: response.cacheReadTokens }),
            ...(response.cacheWriteTokens === undefined
              ? {}
              : { cacheWriteTokens: response.cacheWriteTokens }),
            ...(response.costMicros === undefined ? {} : { costMicros: response.costMicros }),
          },
          finishReason: response.finishReason,
          latencyMs: response.latencyMs,
        },
      });
    }
  }
}

async function runEvalCommand(
  api: EvalPackage,
  context: Parameters<CommandModule["register"]>[1],
  suitePath: string,
  options: EvalOptions,
  dependencies: EvalCommandDependencies,
): Promise<ExitCode> {
  const config = await context.loadConfig();
  const absoluteSuitePath = resolve(suitePath);
  const suite = filterSuite(api, await api.loadSuite(absoluteSuitePath), options.filter);
  validateGraders(suite);
  if (
    (options.isolation !== undefined &&
      !z.enum(["inprocess", "docker"]).safeParse(options.isolation).success) ||
    (options.cassette !== undefined &&
      !z.enum(["record", "replay", "off"]).safeParse(options.cassette).success)
  ) {
    throw new EvalCliError("usage");
  }
  const cassette = options.cassette ?? (options.isolation === "docker" ? "off" : "replay");
  const isolation = options.isolation ?? (cassette === "off" ? "docker" : "inprocess");
  if (isolation === "docker" && cassette === "replay") {
    throw new EvalCliError("eval_docker_cassette_replay_unavailable");
  }
  const failUnder = options.failUnder === undefined ? undefined : nonnegativeNumber(options.failUnder);
  if (failUnder !== undefined && failUnder > 1) {
    throw new EvalCliError("usage");
  }
  const variants = createVariants(api, options.model, cassette, config);
  const outDir = resolve(
    options.out ?? join(process.cwd(), "eval-out", String(context.clock.now())),
  );
  const executor = await (dependencies.createExecutor ?? createDefaultExecutor)(api, {
    isolation,
    cassette,
    suiteDirectory: dirname(absoluteSuitePath),
    config,
    exportTelemetry: options.exportTelemetry ?? false,
    context,
  });
  const results = await api.runEval(suite, variants, executor, {
    outDir,
    concurrency: options.concurrency === undefined ? 2 : positiveInteger(options.concurrency),
    ...(options.trials === undefined ? {} : { trials: positiveInteger(options.trials) }),
    ...(options.seed === undefined ? {} : { seed: positiveInteger(options.seed, true) }),
    ...(options.maxCostUsd === undefined
      ? {}
      : { maxCostUsd: nonnegativeNumber(options.maxCostUsd) }),
  });
  const records = api.parseEvalTrialJsonl(await readFile(join(outDir, "trials.jsonl"), "utf8"));
  const eventsByTrial = await collectTrialEvents(api, suite, variants, records, executor);
  if (cassette === "record") {
    await recordCassettes(dirname(absoluteSuitePath), records, eventsByTrial);
  }
  const grades = await gradeRecords(api, suite, records, eventsByTrial);
  const report = api.buildEvalReport({ trials: records, grades });
  await writeReportFiles(api, outDir, report);
  context.out.table([
    ["Task", "Variant", "Pass rate", "Mean cost (USD)", "Mean steps"],
    ...report.aggregates.map((aggregate) => [
      aggregate.taskId,
      aggregate.variantId,
      `${(aggregate.passRate * 100).toFixed(1)}%`,
      (aggregate.costMicros.mean / 1_000_000).toFixed(6),
      aggregate.steps.mean,
    ]),
  ]);
  context.out.json(api.EvalReportSchema, report);
  if (results.some(({ status }) => status === "skipped_budget")) {
    return ExitCode.budgetExceeded;
  }
  return failUnder !== undefined &&
    report.aggregates.some(({ passRate }) => passRate < failUnder)
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
        .option("--isolation <mode>", "inprocess or docker")
        .option("--cassette <mode>", "record, replay, or off")
        .option("--concurrency <n>", "maximum concurrent trials")
        .option("--out <dir>", "report output directory")
        .option("--seed <n>", "deterministic suite seed")
        .option("--fail-under <rate>", "fail when any pass rate is below this value")
        .option("--max-cost-usd <amount>", "stop starting trials after this cumulative cost")
        .option("--export-telemetry", "export eval telemetry through the configured pipeline", false)
        .action(async (suitePath: string, options: EvalOptions) => {
          const api = await (dependencies.loadEval ?? (() => import("@rovinos/eval")))();
          const result = await runEvalCommand(api, context, suitePath, options, dependencies);
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
