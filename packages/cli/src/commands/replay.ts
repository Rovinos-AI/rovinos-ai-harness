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
import type { GoldenSignature, ReplayReport } from "@rovinos/replay";
import { HarnessError, parseJson } from "@rovinos/schemas";
import type { CommandModule } from "../command.js";
import { createCommandRuntime } from "../command.js";

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

function reportExitCode(report: ReplayReport, strict: boolean, updated: boolean): 0 | 1 | 8 {
  if (updated && report.divergence === undefined) {
    return 0;
  }
  return replayReportExitCode(report, strict);
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
      .action(
        async (options: {
          readonly run?: string;
          readonly trace?: string;
          readonly strict?: boolean;
          readonly golden?: string;
          readonly updateBaseline?: boolean;
          readonly forceInCi?: boolean;
          readonly report?: string;
        }) => {
          if ((options.run === undefined) === (options.trace === undefined)) {
            throw new ReplayInputError();
          }
          if (options.updateBaseline === true && options.golden === undefined) {
            throw new ReplayInputError();
          }
          if (options.forceInCi === true && options.updateBaseline !== true) {
            throw new ReplayInputError();
          }

          const previousGolden =
            options.golden === undefined
              ? undefined
              : await readGolden(options.golden, options.updateBaseline === true);
          const goldenPath = options.golden;
          const config = await context.loadConfig();
          const runtime = await createCommandRuntime(context, config);
          let report: ReplayReport;
          let updated = false;
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
            const comparison =
              previousGolden === undefined
                ? undefined
                : compareGoldenSignature(outcome.events, previousGolden);
            const diff =
              options.golden === undefined
                ? diffRuns(root.events, outcome.events)
                : (comparison?.diff ??
                  compareGoldenSignature(outcome.events, {
                    schemaVersion: 1,
                    containsRealData: false,
                    signature: [],
                  }).diff);
            let goldenMatch = comparison?.match;

            if (
              options.updateBaseline === true &&
              outcome.divergence === undefined &&
              outcome.status !== "error"
            ) {
              assertBaselineUpdateAllowed({
                inCi: isCi(),
                forceInCi: options.forceInCi === true,
              });
              const nextGolden = createGoldenSignature(outcome.events);
              if (goldenPath === undefined) {
                throw new ReplayInputError();
              }
              await writeFile(resolve(goldenPath), renderGoldenSignatureJson(nextGolden), {
                encoding: "utf8",
              });
              goldenMatch = true;
              updated = true;
            }

            report = createReplayReport({
              originalRunId: resolved.rootRunId,
              outcome,
              diff,
              ...(goldenMatch === undefined ? {} : { goldenMatch }),
            });
          } finally {
            await runtime.close();
          }

          if (options.report !== undefined) {
            await writeFile(resolve(options.report), renderReplayReportJson(report), {
              encoding: "utf8",
            });
          }
          if (program.optsWithGlobals<{ json?: boolean }>().json === true) {
            context.out.json(ReplayReportSchema, report);
          } else {
            context.out.print(renderReplayReportText(report));
          }

          const exitCode = reportExitCode(report, options.strict === true, updated);
          if (exitCode === 1) {
            throw new ReplayExitError("replay_behavior_difference");
          }
          if (exitCode === 8) {
            throw new ReplayExitError("replay_failed");
          }
        },
      );
  },
};
