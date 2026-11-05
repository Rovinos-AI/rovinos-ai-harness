// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import * as evalApi from "@rovinos/eval";
import { parseJson } from "@rovinos/schemas";
import type { TrialExecutor, TrialSpec } from "@rovinos/eval";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("harness eval run", () => {
  it("runs the variants from a validated YAML file", async () => {
    const suitePath = await createSuite();
    const variantsPath = join(temporaryDirectory ?? "", "variants.yaml");
    const outputDirectory = join(temporaryDirectory ?? "", "variant-reports");
    const trials: TrialSpec[] = [];
    await writeFile(
      variantsPath,
      [
        "variants:",
        "  - id: baseline",
        "    route:",
        "      - provider: openai",
        "        model: synthetic_a",
        "    configOverrides:",
        "      run:",
        "        budgets:",
        "          maxSteps: 15",
        "  - id: candidate",
        "    contextStrategy: compact",
      ].join("\n"),
      "utf8",
    );
    const { context } = createContext();
    const command = createEvalCommand({
      loadEval: () => Promise.resolve(evalApi),
      createExecutor: () => createExecutor("completed", 0, trials),
    });

    const exitCode = await main(
      ["eval", "run", suitePath, "--variants", variantsPath, "--out", outputDirectory],
      context,
      [command],
    );

    expect(exitCode).toBe(ExitCode.ok);
    expect(trials).toHaveLength(4);
    expect(new Set(trials.map(({ variantId }) => variantId))).toEqual(
      new Set(["baseline", "candidate"]),
    );
    expect(trials.find(({ variantId }) => variantId === "baseline")?.variant.models).toEqual([
      { provider: "openai", model: "synthetic_a" },
    ]);
  });

  it("parses model, trial, filter, output, and telemetry options and writes reports", async () => {
    const suitePath = await createSuite();
    const outputDirectory = join(temporaryDirectory ?? "", "reports");
    const trials: TrialSpec[] = [];
    let executorOptions:
      Parameters<NonNullable<EvalCommandDependencies["createExecutor"]>>[1] | undefined;
    const { context, stdout, stderr } = createContext();
    context.loadConfig = () =>
      Promise.resolve(
        HarnessConfigSchema.parse({
          models: {
            providers: [
              {
                id: "openai",
                kind: "openai_compatible",
                trust: "local",
                baseUrl: "https://provider.example.invalid/v1",
              },
              {
                id: "anthropic",
                kind: "openai_compatible",
                trust: "local",
                baseUrl: "https://provider.example.invalid/v1",
              },
            ],
          },
        }),
      );
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
        "--live",
        "--max-model-calls",
        "7",
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
    expect(stderr).toEqual(["eval_live_inprocess_not_isolated\n"]);
    expect(await readdir(outputDirectory)).toEqual(
      expect.arrayContaining(["trials.jsonl", "eval-report.json", "eval-report.md", "junit.xml"]),
    );
  });

  it("keeps telemetry disabled by default and emits one validated JSON report", async () => {
    const suitePath = await createSuite();
    const outputDirectory = join(temporaryDirectory ?? "", "reports");
    const trials: TrialSpec[] = [];
    let executorOptions:
      { exportTelemetry: boolean; cassette: string; isolation: string } | undefined;
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
      [
        "eval",
        "run",
        suitePath,
        "--filter",
        "selected_task",
        "--fail-under",
        "0.5",
        "--out",
        outputDirectory,
      ],
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

  it("reports a missing sandbox capability as a grader failure instead of rejecting the suite", async () => {
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

    const output = join(temporaryDirectory ?? "", "reports");
    const exitCode = await main(
      ["eval", "run", suitePath, "--out", output, "--fail-under", "1"],
      context,
      [command],
    );

    expect(exitCode).toBe(ExitCode.failure);
    expect(executorStarted).toBe(true);
    expect(stderr).toEqual(["eval_failed\n"]);
    expect(await readFile(join(output, "eval-report.json"), "utf8")).toContain(
      "eval_test_command_context_unavailable",
    );
  });

  it("rejects Docker judge suites with a grader-specific typed code", async () => {
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

    const exitCode = await main(["eval", "run", suitePath, "--isolation", "docker"], context, [
      command,
    ]);

    expect(exitCode).toBe(ExitCode.failure);
    expect(executorStarted).toBe(false);
    expect(stderr).toEqual(["eval_llm_judge_docker_unavailable\n"]);
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

  it("requires live opt-in for in-process calls before constructing an executor", async () => {
    const suitePath = await createSuite();
    let executorStarted = false;
    const { context, stderr } = createContext();
    const exitCode = await main(
      ["eval", "run", suitePath, "--isolation", "inprocess", "--cassette", "off"],
      context,
      [
        createEvalCommand({
          createExecutor: () => {
            executorStarted = true;
            return createExecutor("completed", 0, []);
          },
        }),
      ],
    );
    expect(exitCode).toBe(ExitCode.failure);
    expect(executorStarted).toBe(false);
    expect(stderr).toEqual(["eval_inprocess_live_model_unavailable\n"]);
  });

  it.each(["docker", "inprocess"] as const)(
    "shares a bounded live session with the %s executor and closes it",
    async (isolation) => {
      const suitePath = await createSuite();
      const config = HarnessConfigSchema.parse({
        models: {
          providers: [
            {
              id: "local",
              kind: "openai_compatible",
              trust: "local",
              baseUrl: "https://provider.example.invalid/v1",
            },
          ],
          routing: { default: [{ provider: "local", model: "synthetic" }] },
        },
      });
      const session = await evalApi.createLiveModelSession({ models: config.models, maxCalls: 7 });
      const close = vi.spyOn(session, "close");
      const start = vi.spyOn(evalApi, "createLiveModelSession").mockResolvedValue(session);
      const { context, stderr } = createContext();
      context.loadConfig = () => Promise.resolve(config);
      let received:
        Parameters<NonNullable<EvalCommandDependencies["createExecutor"]>>[1] | undefined;
      const exit = await main(
        [
          "eval",
          "run",
          suitePath,
          "--cassette",
          "off",
          "--live",
          "--isolation",
          isolation,
          "--max-model-calls",
          "7",
          "--out",
          join(temporaryDirectory ?? "", "live"),
        ],
        context,
        [
          createEvalCommand({
            createExecutor: (_api, options) => {
              received = options;
              return createExecutor("completed", 0, []);
            },
          }),
        ],
      );

      expect(exit).toBe(ExitCode.ok);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ maxCalls: 7 }));
      expect(received?.liveSession).toBe(session);
      expect(received?.isolation).toBe(isolation);
      expect(close).toHaveBeenCalledExactlyOnceWith();
      expect(stderr).toEqual(
        isolation === "inprocess" ? ["eval_live_inprocess_not_isolated\n"] : [],
      );
    },
  );

  it("passes the credential canary grader through a live host model port", async () => {
    const suitePath = await createSuite();
    const credential = "synthetic-live-staging-credential";
    await writeFile(
      suitePath,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            id: "live_canary",
            input: { goal: "synthetic goal" },
            tags: [],
            graders: [{ type: "no_canary_leak" }],
            canaries: [credential],
          },
        ],
      }),
    );
    const config = HarnessConfigSchema.parse({
      models: {
        providers: [
          {
            id: "openai",
            kind: "openai",
            apiKey: "env:STAGING_SYNTHETIC_KEY",
            streaming: false,
          },
        ],
        routing: { default: [{ provider: "openai", model: "synthetic" }] },
        retry: { maxAttempts: 1 },
      },
    });
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          id: "synthetic_response",
          object: "chat.completion",
          created: 0,
          model: "synthetic",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "synthetic answer" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      ),
    );
    vi.stubGlobal("fetch", transport);
    vi.stubEnv("OPENAI_LOG", "debug");
    const { context, stdout, stderr } = createContext();
    context.loadConfig = () => Promise.resolve(config);
    context.secretResolver = { resolve: () => Promise.resolve({ reveal: () => credential }) };
    const out = join(temporaryDirectory ?? "", "live-canary");
    const exit = await main(
      [
        "eval",
        "run",
        suitePath,
        "--cassette",
        "off",
        "--live",
        "--isolation",
        "inprocess",
        "--out",
        out,
        "--fail-under",
        "1",
      ],
      context,
      [createEvalCommand()],
    );
    expect(exit).toBe(ExitCode.ok);
    expect(transport).toHaveBeenCalledTimes(1);
    const report = parseJson(
      evalApi.EvalReportSchema,
      await readFile(join(out, "eval-report.json"), "utf8"),
    );
    expect(report.trials[0]?.graders).toContainEqual({
      graderId: "no_canary_leak",
      pass: true,
      codes: [],
    });
    expect(JSON.stringify({ stdout, stderr, report })).not.toContain(credential);
  });

  it.each(["cap", "cancel", "setup"] as const)(
    "fails a live run on %s and always closes the host session",
    async (failure) => {
      const suitePath = await createSuite();
      const config = HarnessConfigSchema.parse({
        models: {
          providers: [
            {
              id: "local",
              kind: "openai_compatible",
              trust: "local",
              baseUrl: "https://provider.example.invalid/v1",
            },
          ],
          routing: { default: [{ provider: "local", model: "synthetic" }] },
        },
      });
      const session = await evalApi.createLiveModelSession({ models: config.models, maxCalls: 1 });
      const close = vi.spyOn(session, "close");
      vi.spyOn(evalApi, "createLiveModelSession").mockResolvedValue(session);
      if (failure === "cap") {
        vi.spyOn(session, "failureCode", "get").mockReturnValue("eval_live_call_limit_exceeded");
      }
      const { context, stderr } = createContext();
      context.loadConfig = () => Promise.resolve(config);
      const listeners = process.listenerCount("SIGINT");
      const exit = await main(
        [
          "eval",
          "run",
          suitePath,
          "--cassette",
          "off",
          "--live",
          "--out",
          join(temporaryDirectory ?? "", "live"),
        ],
        context,
        [
          createEvalCommand({
            createExecutor: () => {
              if (failure === "setup") {
                throw new Error("synthetic private setup details");
              }
              if (failure === "cancel") {
                process.emit("SIGINT");
              }
              return createExecutor("completed", 0, []);
            },
          }),
        ],
      );
      expect(exit).toBe(ExitCode.failure);
      expect(close).toHaveBeenCalledExactlyOnceWith();
      expect(process.listenerCount("SIGINT")).toBe(listeners);
      expect(stderr.join("")).not.toContain("private");
      const expectedCode = {
        cap: "eval_live_call_limit_exceeded",
        cancel: "eval_live_cancelled",
        setup: "failure",
      }[failure];
      expect(stderr.join("")).toContain(expectedCode);
    },
  );

  it.each([
    ["--live", "--cassette", "replay", "eval_live_cassette_conflict"],
    [
      "--live",
      "--isolation",
      "docker",
      "--cassette",
      "record",
      "eval_docker_cassette_record_unavailable",
    ],
    ["--live", "--cassette", "off", "--max-model-calls", "0", "usage"],
  ])("rejects unsupported live configuration %j", async (...flags) => {
    const suitePath = await createSuite();
    const code = flags.pop();
    const { context, stderr } = createContext();
    const exit = await main(["eval", "run", suitePath, ...flags], context, [createEvalCommand()]);
    expect(exit).not.toBe(ExitCode.ok);
    expect(stderr.join("")).toContain(code);
  });
});
