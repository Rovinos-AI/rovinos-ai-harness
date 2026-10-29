// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertBaselineUpdateAllowed,
  compareGoldenSignature,
  createGoldenSignature,
  createReplayReport,
  diffRuns,
  GoldenSignatureSchema,
  renderGoldenSignatureJson,
  renderReplayReportJson,
  renderReplayReportText,
  ReplayInputError,
  ReplayReportSchema,
  replayReportExitCode,
  replayRun,
  resolveRun,
} from "@rovinos/replay";
import type { DiffResult, GoldenSignature, ReplayReport, ReplayOutcome } from "@rovinos/replay";
import { HarnessError, parseJson } from "@rovinos/schemas";
import type { HarnessConfig } from "@rovinos/config";
import type { Command } from "commander";
import { createCommandRuntime, type CliContext, type CommandModule } from "../command.js";

interface ReplayOptions {
  readonly run?: string;
  readonly trace?: string;
  readonly strict?: boolean;
  readonly golden?: string;
  readonly updateBaseline?: boolean;
  readonly forceInCi?: boolean;
  readonly report?: string;
}

interface ReplayExecution {
  readonly report: ReplayReport;
  readonly updated: boolean;
}

interface ReplayComparison {
  readonly diff: DiffResult;
  readonly goldenMatch?: boolean;
}

class ReplayExitError extends HarnessError {
  override readonly code: string;

  constructor(code: "replay_behavior_difference" | "replay_failed") {
    super(code);
    this.code = code;
  }
}

class ReplayMissingRootError extends HarnessError {
  override readonly code = "replay_missing_result";

  constructor() {
    super("Resolved replay has no root run.");
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readGolden(path: string, allowMissing: boolean): Promise<GoldenSignature | undefined> {
  let contents: string;
  try {
    contents = await readFile(resolve(path), { encoding: "utf8" });
  } catch (error) {
    if (allowMissing && isMissingFile(error)) {
      return undefined;
    }
    throw new ReplayInputError();
  }
  try {
    return parseJson(GoldenSignatureSchema, contents);
  } catch {
    throw new ReplayInputError();
  }
}

function isCi(): boolean {
  return (
    process.env.CI === "1" ||
    process.env.CI?.toLowerCase() === "true" ||
    process.env.GITHUB_ACTIONS?.toLowerCase() === "true"
  );
}

function validateOptions(options: ReplayOptions): void {
  if ((options.run === undefined) === (options.trace === undefined)) {
    throw new ReplayInputError();
  }
  if (options.updateBaseline === true && options.golden === undefined) {
    throw new ReplayInputError();
  }
  if (options.forceInCi === true && options.updateBaseline !== true) {
    throw new ReplayInputError();
  }
}

function comparisonFor(
  rootEvents: Parameters<typeof diffRuns>[0],
  outcome: ReplayOutcome,
  options: ReplayOptions,
  golden: GoldenSignature | undefined,
): ReplayComparison {
  if (options.golden === undefined) {
    return { diff: diffRuns(rootEvents, outcome.events) };
  }
  const baseline =
    golden ??
    GoldenSignatureSchema.parse({
      schemaVersion: 1,
      containsRealData: false,
      signature: [],
    });
  const comparison = compareGoldenSignature(outcome.events, baseline);
  return {
    diff: comparison.diff,
    ...(golden === undefined ? {} : { goldenMatch: comparison.match }),
  };
}

async function updateBaseline(
  options: ReplayOptions,
  outcome: ReplayOutcome,
): Promise<boolean> {
  if (
    options.updateBaseline !== true ||
    outcome.divergence !== undefined ||
    outcome.status === "error"
  ) {
    return false;
  }
  assertBaselineUpdateAllowed({
    inCi: isCi(),
    forceInCi: options.forceInCi === true,
  });
  if (options.golden === undefined) {
    throw new ReplayInputError();
  }
  const nextGolden = createGoldenSignature(outcome.events);
  await writeFile(resolve(options.golden), renderGoldenSignatureJson(nextGolden), {
    encoding: "utf8",
  });
  return true;
}

async function executeReplay(
  options: ReplayOptions,
  context: CliContext,
): Promise<ReplayExecution> {
  const previousGolden =
    options.golden === undefined
      ? undefined
      : await readGolden(options.golden, options.updateBaseline === true);
  const config: HarnessConfig = await context.loadConfig();
  const runtime = await createCommandRuntime(context, config);
  try {
    const resolved = await resolveRun({
      store: runtime.store,
      ...(options.run === undefined ? {} : { runId: options.run }),
      ...(options.trace === undefined ? {} : { traceId: options.trace }),
    });
    const root = resolved.runs.find(({ runId }) => runId === resolved.rootRunId);
    if (root === undefined) {
      throw new ReplayMissingRootError();
    }
    const outcome = await replayRun(resolved, { config: { run: config.run } });
    const comparison = comparisonFor(root.events, outcome, options, previousGolden);
    const updated = await updateBaseline(options, outcome);
    const goldenMatch = updated ? true : comparison.goldenMatch;
    return {
      report: createReplayReport({
        originalRunId: resolved.rootRunId,
        outcome,
        diff: comparison.diff,
        ...(goldenMatch === undefined ? {} : { goldenMatch }),
      }),
      updated,
    };
  } finally {
    await runtime.close();
  }
}

async function writeReportFile(path: string | undefined, report: ReplayReport): Promise<void> {
  if (path !== undefined) {
    await writeFile(resolve(path), renderReplayReportJson(report), { encoding: "utf8" });
  }
}

function emitReport(program: Command, context: CliContext, report: ReplayReport): void {
  if (program.optsWithGlobals<{ json?: boolean }>().json === true) {
    context.out.json(ReplayReportSchema, report);
  } else {
    context.out.print(renderReplayReportText(report));
  }
}

async function runReplayCommand(
  program: Command,
  context: CliContext,
  options: ReplayOptions,
): Promise<void> {
  validateOptions(options);
  const execution = await executeReplay(options, context);
  await writeReportFile(options.report, execution.report);
  emitReport(program, context, execution.report);

  const exitCode =
    execution.updated && execution.report.divergence === undefined
      ? 0
      : replayReportExitCode(execution.report, options.strict === true);
  if (exitCode === 1) {
    throw new ReplayExitError("replay_behavior_difference");
  }
  if (exitCode === 8) {
    throw new ReplayExitError("replay_failed");
  }
}

/** Registers the `harness replay` reproduction and reporting command. */
export const replayCommand: CommandModule = {
  name: "replay",
  /** Registers replay selectors, report options, and safe baseline updates. */
  register(program, context) {
    program
      .command("replay")
      .description("Replay a recorded run and report normalized differences")
      .option("--run <id>", "run identifier")
      .option("--trace <id>", "trace identifier or W3C traceparent")
      .option("--strict", "fail on any replay difference, including noise")
      .option("--golden <file>", "golden baseline file")
      .option("--update-baseline", "explicitly update the golden baseline")
      .option("--force-in-ci", "allow an explicit baseline update in CI")
      .option("--report <path>", "write the JSON replay report")
      .action((options: ReplayOptions) => runReplayCommand(program, context, options));
  },
};
