// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import * as evalApi from "@rovinos/eval";
import { parseJson } from "@rovinos/schemas";
import type { TrialExecutor, TrialSpec } from "@rovinos/eval";
import { afterEach, describe, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import type { EvalCommandDependencies } from "./eval.js";
import { createEvalCommand } from "./eval.js";

let temporaryDirectory: string | undefined;

async function createSuite(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-eval-cli-"));
  const path = join(temporaryDirectory, "suite.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      tasks: [
        {
          id: "selected_task",
          input: { goal: "synthetic goal" },
          graders: [],
          tags: ["selected"],
          trials: 1,
        },
        {
          id: "other_task",
          input: { goal: "another synthetic goal" },
          graders: [],
          tags: ["other"],
        },
      ],
    }),
    "utf8",
  );
  return path;
}

function createContext() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: () => Promise.resolve(HarnessConfigSchema.parse({})),
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: { now: () => 1_234 },
  };
  return { context, stdout, stderr };
}

function createExecutor(
  status: "completed" | "failed",
  costMicros: number,
  trials: TrialSpec[],
): TrialExecutor {
  return {
    run: (trial) => {
      trials.push(trial);
      return Promise.resolve(
        evalApi.TrialResultSchema.parse({
          status,
          dbPath: join(trial.workDir, "data", "harness.db"),
          workspaceDir: join(trial.workDir, "workspace"),
          durationMs: 1,
          usage: { inputTokens: 2, outputTokens: 3, costMicros },
          exitCode: status === "completed" ? 0 : 1,
        }),
      );
    },
  };
}

afterEach(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("harness eval run", () => {
  it("parses model, trial, filter, output, and telemetry options and writes reports", async () => {
    const suitePath = await createSuite();
    const outputDirectory = join(temporaryDirectory ?? "", "reports");
    const trials: TrialSpec[] = [];
    let executorOptions:
      | Parameters<NonNullable<EvalCommandDependencies["createExecutor"]>>[1]
      | undefined;
    const { context, stdout, stderr } = createContext();
    const command = createEvalCommand({
      loadEval: () => Promise.resolve(evalApi),
      createExecutor: (_api, options) => {
        executorOptions = options;
        return createExecutor("completed", 0, trials);
      },
    });

    const exitCode = await main(
      [
        "eval",
        "run",
        suitePath,
        "--model",
        "openai/alpha,anthropic/beta",
        "--trials",
        "2",
        "--filter",
        "selected",
        "--concurrency",
        "1",
        "--seed",
        "44",
        "--isolation",
        "inprocess",
        "--cassette",
        "off",
        "--export-telemetry",
        "--out",
        outputDirectory,
      ],
      context,
      [command],
    );

    expect(exitCode).toBe(ExitCode.ok);
    expect(trials).toHaveLength(4);
    expect(new Set(trials.map(({ task }) => task.id))).toEqual(new Set(["selected_task"]));
    expect(new Set(trials.map(({ trialIndex }) => trialIndex))).toEqual(new Set([0, 1]));
    expect(
      trials
        .filter(({ trialIndex }) => trialIndex === 0)
        .map(({ variant }) => variant.models?.[0]?.model),
    ).toEqual(["alpha", "beta"]);
    expect(executorOptions).toMatchObject({
      cassette: "off",
      isolation: "inprocess",
      exportTelemetry: true,
    });
    expect(stdout.join("")).toContain("selected_task");
    expect(stderr).toEqual([]);
    expect(await readdir(outputDirectory)).toEqual(
      expect.arrayContaining(["trials.jsonl", "eval-report.json", "eval-report.md", "junit.xml"]),
    );
  });

  it("keeps telemetry disabled by default and emits one validated JSON report", async () => {
    const suitePath = await createSuite();
    const outputDirectory = join(temporaryDirectory ?? "", "reports");
    const trials: TrialSpec[] = [];
    let executorOptions: { exportTelemetry: boolean; cassette: string; isolation: string } | undefined;
    const { context, stdout, stderr } = createContext();
    const command = createEvalCommand({
      loadEval: () => Promise.resolve(evalApi),
      createExecutor: (_api, options) => {
        executorOptions = options;
        return createExecutor("completed", 0, trials);
      },
    });

    const exitCode = await main(
      ["--json", "eval", "run", suitePath, "--out", outputDirectory],
      context,
      [command],
    );
    const documents = stdout.join("").trim().split("\n");

    expect(exitCode).toBe(ExitCode.ok);
    expect(documents).toHaveLength(1);
    expect(parseJson(evalApi.EvalReportSchema, documents[0] ?? "").aggregates).toHaveLength(2);
    expect(executorOptions).toEqual({
      cassette: "replay",
      isolation: "inprocess",
      exportTelemetry: false,
      suiteDirectory: temporaryDirectory,
      config: HarnessConfigSchema.parse({}),
      context,
    });
    expect(stderr.join("")).toContain("Task\tVariant");
  });

  it("returns failure when a pass-rate threshold is unmet", async () => {
    const suitePath = await createSuite();
    const outputDirectory = join(temporaryDirectory ?? "", "reports");
    const trials: TrialSpec[] = [];
    const { context, stderr } = createContext();
    const command = createEvalCommand({
      loadEval: () => Promise.resolve(evalApi),
      createExecutor: () => createExecutor("failed", 0, trials),
    });

    const exitCode = await main(
      ["eval", "run", suitePath, "--filter", "selected_task", "--fail-under", "0.5", "--out", outputDirectory],
      context,
      [command],
    );

    expect(exitCode).toBe(ExitCode.failure);
    expect(stderr).toEqual(["eval_failed\n"]);
  });

  it("returns budget-exceeded when the cost cap skips remaining trials", async () => {
    const suitePath = await createSuite();
    const outputDirectory = join(temporaryDirectory ?? "", "reports");
    const trials: TrialSpec[] = [];
    const { context, stderr } = createContext();
    const command = createEvalCommand({
      loadEval: () => Promise.resolve(evalApi),
      createExecutor: () => createExecutor("completed", 2_000_000, trials),
    });

    const exitCode = await main(
      [
        "eval",
        "run",
        suitePath,
        "--filter",
        "selected_task",
        "--trials",
        "3",
        "--concurrency",
        "1",
        "--max-cost-usd",
        "1",
        "--out",
        outputDirectory,
      ],
      context,
      [command],
    );
    const lines = (await import("node:fs/promises")).readFile(
      join(outputDirectory, "trials.jsonl"),
      "utf8",
    );

    expect(exitCode).toBe(ExitCode.budgetExceeded);
    expect(trials).toHaveLength(1);
    expect(await lines).toContain('"status":"skipped_budget"');
    expect(stderr).toEqual(["budget_exceeded\n"]);
  });

  it("rejects test_command before trials with its typed context code", async () => {
    const suitePath = await createSuite();
    await writeFile(
      suitePath,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            id: "selected_task",
            input: { goal: "synthetic goal" },
            graders: [{ type: "test_command", argv: ["node", "--version"] }],
            tags: ["selected"],
          },
        ],
      }),
      "utf8",
    );
    let executorStarted = false;
    const { context, stderr } = createContext();
    const command = createEvalCommand({
      loadEval: () => Promise.resolve(evalApi),
      createExecutor: () => {
        executorStarted = true;
        return createExecutor("completed", 0, []);
      },
    });

    const exitCode = await main(["eval", "run", suitePath], context, [command]);

    expect(exitCode).toBe(ExitCode.failure);
    expect(executorStarted).toBe(false);
    expect(stderr).toEqual(["eval_test_command_context_unavailable\n"]);
  });

  it("rejects llm_judge before trials with its typed context code", async () => {
    const suitePath = await createSuite();
    await writeFile(
      suitePath,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            id: "selected_task",
            input: { goal: "synthetic goal" },
            graders: [
              {
                type: "llm_judge",
                rubricId: "synthetic_rubric",
                rubric: "- id: criterion\n  description: synthetic criterion\n  weight: 1",
                model: { provider: "openai", model: "synthetic_model" },
                passThreshold: 0.5,
              },
            ],
            tags: ["selected"],
          },
        ],
      }),
      "utf8",
    );
    let executorStarted = false;
    const { context, stderr } = createContext();
    const command = createEvalCommand({
      loadEval: () => Promise.resolve(evalApi),
      createExecutor: () => {
        executorStarted = true;
        return createExecutor("completed", 0, []);
      },
    });

    const exitCode = await main(["eval", "run", suitePath], context, [command]);

    expect(exitCode).toBe(ExitCode.failure);
    expect(executorStarted).toBe(false);
    expect(stderr).toEqual(["eval_llm_judge_context_unavailable\n"]);
  });

  it("fails Docker cassette-off before constructing the executor", async () => {
    const suitePath = await createSuite();
    let executorStarted = false;
    const { context, stderr } = createContext();
    const command = createEvalCommand({
      loadEval: () => Promise.resolve(evalApi),
      createExecutor: () => {
        executorStarted = true;
        return createExecutor("completed", 0, []);
      },
    });

    const exitCode = await main(
      ["eval", "run", suitePath, "--isolation", "docker", "--cassette", "off"],
      context,
      [command],
    );

    expect(exitCode).toBe(ExitCode.failure);
    expect(executorStarted).toBe(false);
    expect(stderr).toEqual(["eval_docker_live_model_unavailable\n"]);
  });
});
