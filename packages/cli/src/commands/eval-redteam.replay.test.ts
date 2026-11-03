// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessConfigSchema } from "@rovinos/config";
import { PolicyEngine } from "@rovinos/policy";
import type { PolicyPort, ToolPort } from "@rovinos/core";
import * as evalApi from "@rovinos/eval";
import { CassetteFileSchema } from "@rovinos/models";
import { Code, JsonValue, ToolSpecSchema, parseJson } from "@rovinos/schemas";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { cassetteModelFactory } from "./eval-cassettes.js";
import { createEvalCommand } from "./eval.js";
import type { EvalCommandDependencies } from "./eval.js";

const suiteSourcePath = fileURLToPath(
  new URL("../../../../evals/redteam/suite.ts", import.meta.url),
);
const redTeamDirectory = fileURLToPath(new URL("../../../../evals/redteam/", import.meta.url));
const attacksPath = join(redTeamDirectory, "cassettes", "attacks.json");

let temporaryDirectory: string | undefined;

vi.setConfig({ testTimeout: 15_000 });

const RedTeamCassetteSchema = z
  .object({
    schemaVersion: z.literal(1),
    cases: z
      .array(
        z
          .object({
            taskId: Code,
            response: z
              .object({
                type: z.literal("tool_call"),
                toolId: Code,
                args: JsonValue,
              })
              .strict(),
            policyDecision: z.enum(["ask", "deny"]),
            expectedStatus: z.enum(["suspended", "failed", "completed"]),
            forbiddenTool: Code,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((cassette, context) => {
    const taskIds = new Set<string>();
    for (const [index, testCase] of cassette.cases.entries()) {
      if (taskIds.has(testCase.taskId)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "taskId"],
          message: "Red-team cassette task ids must be unique.",
        });
      }
      taskIds.add(testCase.taskId);
    }
  });

type RedTeamCassette = z.infer<typeof RedTeamCassetteSchema>;

function registeredTools(
  cases: readonly RedTeamCassette["cases"][number][],
  executions: Map<string, number>,
  taskId: string,
): ToolPort {
  const toolIds = [...new Set(cases.map(({ response }) => response.toolId))];
  const specs = toolIds.map((toolId) =>
    ToolSpecSchema.parse({
      toolId,
      description: "Synthetic red-team target.",
      inputSchema: JsonValue.parse({ type: "object" }),
    }),
  );
  return {
    getToolSpecs: () => specs,
    describe: (toolId) =>
      toolIds.includes(toolId) ? { idempotent: false, timeoutMs: 1_000 } : undefined,
    execute: (_call) => {
      executions.set(taskId, (executions.get(taskId) ?? 0) + 1);
      return Promise.resolve({ outcome: "ok", result: null });
    },
  };
}

function policyFor(testCase: RedTeamCassette["cases"][number], mutation = false): PolicyPort {
  const decision = mutation ? "allow" : testCase.policyDecision;
  const match =
    testCase.taskId === "nested_argument_smuggling"
      ? {
          tools: [testCase.response.toolId],
          args: [{ pointer: "/operation/target", op: "equals" as const, value: "sensitive" }],
        }
      : { tools: [testCase.response.toolId] };
  return new PolicyEngine({
    version: 1,
    defaultDecision: "deny",
    rules: [
      {
        id: "redteam_attack",
        match,
        decision,
        reason: "redteam_attack",
        ...(decision === "ask" ? { editable: ["/target"] } : {}),
      },
    ],
  });
}

function createContext(): CliContext {
  return {
    loadConfig: () => Promise.resolve(HarnessConfigSchema.parse({})),
    out: createOutput({ stdout: () => undefined, stderr: () => undefined }),
    clock: { now: () => 1_234 },
  };
}

async function loadAttacks(): Promise<RedTeamCassette> {
  return parseJson(RedTeamCassetteSchema, await readFile(attacksPath, "utf8"));
}

afterEach(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

it("replays validated attacks through the registered tool and policy path", async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-redteam-eval-"));
  const attacks = await loadAttacks();
  const suite = await evalApi.loadSuite(suiteSourcePath);
  const tasksById = new Map(suite.tasks.map((task) => [task.id, task]));
  const attacksById = new Map(attacks.cases.map((testCase) => [testCase.taskId, testCase]));
  const executions = new Map<string, number>();
  let executor: evalApi.InProcessExecutor | undefined;
  const dependencies: EvalCommandDependencies = {
    createExecutor: (api, options) => {
      executor = new api.InProcessExecutor({
        model: cassetteModelFactory(options.suiteDirectory),
        tool: (trial) => registeredTools(attacks.cases, executions, trial.task.id),
        policy: (trial) => {
          const testCase = attacksById.get(trial.task.id);
          if (testCase === undefined) {
            throw new Error("redteam_case_missing");
          }
          return policyFor(testCase);
        },
      });
      return executor;
    },
  };
  const replayOutput = join(temporaryDirectory, "replay");
  const replayExit = await main(
    [
      "eval",
      "run",
      suiteSourcePath,
      "--model",
      "openai/redteam",
      "--isolation",
      "inprocess",
      "--cassette",
      "replay",
      "--out",
      replayOutput,
    ],
    createContext(),
    [createEvalCommand(dependencies)],
  );
  const report = parseJson(
    evalApi.EvalReportSchema,
    await readFile(join(replayOutput, "eval-report.json"), "utf8"),
  );

  expect(replayExit).toBe(ExitCode.ok);
  expect(report.invariantsEnabled).toBe(true);
  expect(report.trials).toHaveLength(attacks.cases.length);
  expect(suite.tasks).toHaveLength(attacks.cases.length);
  expect(executor).toBeDefined();

  for (const testCase of attacks.cases) {
    const task = tasksById.get(testCase.taskId);
    const trajectory = task?.graders.find((grader) => grader.type === "trajectory");
    const trial = evalApi.TrialSpecSchema.parse({
      suite,
      task,
      variantId: "model_1",
      variant: { id: "model_1", models: [{ provider: "openai", model: "redteam" }] },
      trialIndex: 0,
      seed: 1,
      workDir: join(temporaryDirectory, testCase.taskId),
    });
    const events = executor?.eventsFor(trial) ?? [];
    const trialReport = report.trials.find(({ taskId }) => taskId === testCase.taskId);
    const cassette = parseJson(
      CassetteFileSchema,
      await readFile(join(redTeamDirectory, "cassettes", testCase.taskId, "model_1.json"), "utf8"),
    );
    const cassetteToolCall = cassette.entries
      .flatMap(({ response }) => response.parts)
      .find((part) => part.type === "tool_call");

    expect(task).toBeDefined();
    expect(trajectory).toMatchObject({
      type: "trajectory",
      assertions: [
        { type: "final_status", status: testCase.expectedStatus },
        { type: "tool_never_executed", toolId: testCase.forbiddenTool },
      ],
    });
    expect(cassetteToolCall).toMatchObject({
      type: "tool_call",
      toolId: testCase.response.toolId,
      args: testCase.response.args,
    });
    expect(trialReport?.status).toBe(testCase.expectedStatus);
    expect(trialReport?.graders).toEqual(
      expect.arrayContaining([
        { graderId: "approval_integrity", pass: true, codes: [] },
        { graderId: "no_denied_executed", pass: true, codes: [] },
        { graderId: "trajectory", pass: true, codes: [] },
      ]),
    );
    expect(events.some((event) => event.type === "run_created")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "tool_intent" &&
          event.toolId === testCase.response.toolId &&
          event.policyDecision === testCase.policyDecision,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "tool_result" &&
          event.toolId === testCase.forbiddenTool &&
          event.outcome === "ok",
      ),
    ).toBe(false);
    expect(events.some((event) => event.type === "approval_resolved")).toBe(false);
    expect(evalApi.verifyInvariants(events)).toEqual([]);
    expect(executions.get(testCase.taskId) ?? 0).toBe(0);
    for (const grader of trialReport?.graders ?? []) {
      expect(grader.codes.every((code) => /^[a-z0-9_.-]+$/u.test(code))).toBe(true);
    }
  }

  expect(JSON.stringify(report)).not.toContain("synthetic-pending");
  expect(JSON.stringify(report)).not.toContain("synthetic-denied");
});

it("fails the suite mutation when a pending approval is bypassed", async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-redteam-mutation-"));
  const attacks = await loadAttacks();
  const testCase = attacks.cases.find(({ policyDecision }) => policyDecision === "ask");
  if (testCase === undefined) {
    throw new Error("redteam_ask_case_missing");
  }
  const executions = new Map<string, number>();
  let executor: evalApi.InProcessExecutor | undefined;
  const dependencies: EvalCommandDependencies = {
    createExecutor: (api, options) => {
      executor = new api.InProcessExecutor({
        model: cassetteModelFactory(options.suiteDirectory),
        tool: (trial) => registeredTools(attacks.cases, executions, trial.task.id),
        policy: () => policyFor(testCase, true),
      });
      return executor;
    },
  };
  const replayOutput = join(temporaryDirectory, "mutation");
  const replayExit = await main(
    [
      "eval",
      "run",
      suiteSourcePath,
      "--filter",
      testCase.taskId,
      "--model",
      "openai/redteam",
      "--isolation",
      "inprocess",
      "--cassette",
      "replay",
      "--fail-under",
      "1",
      "--out",
      replayOutput,
    ],
    createContext(),
    [createEvalCommand(dependencies)],
  );
  const report = parseJson(
    evalApi.EvalReportSchema,
    await readFile(join(replayOutput, "eval-report.json"), "utf8"),
  );
  const trial = report.trials[0];
  const trajectory = trial?.graders.find(({ graderId }) => graderId === "trajectory");

  expect(replayExit).toBe(ExitCode.failure);
  expect(executions.get(testCase.taskId)).toBe(1);
  expect(trajectory?.pass).toBe(false);
  expect(trajectory?.codes).toContain("tool_executed_unexpectedly");
  expect(executor).toBeDefined();
});
