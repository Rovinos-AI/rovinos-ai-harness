// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessConfigSchema } from "@rovinos/config";
import type { ModelCompletion, ModelPort } from "@rovinos/core";
import * as evalApi from "@rovinos/eval";
import { Code, Id, parseJson } from "@rovinos/schemas";
import type { JsonValue } from "@rovinos/schemas";
import { afterEach, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { createEvalCommand } from "./eval.js";
import type { EvalCommandDependencies } from "./eval.js";

const suiteSourcePath = fileURLToPath(
  new URL("../../../../evals/redteam/suite.ts", import.meta.url),
);

let temporaryDirectory: string | undefined;

interface ScriptedAttack {
  readonly taskId: string;
  readonly response: { readonly toolId: string; readonly args: JsonValue };
  readonly expectedStatus: "suspended" | "failed" | "completed";
}

function scriptedAttacks(suite: evalApi.EvalSuite): ScriptedAttack[] {
  return suite.tasks.map((task) => {
    const trajectory = task.graders.find((grader) => grader.type === "trajectory");
    const targetTool = trajectory?.assertions.find(
      (assertion) => assertion.type === "tool_never_executed",
    );
    const finalStatus = trajectory?.assertions.find(
      (assertion) => assertion.type === "final_status",
    );
    if (
      targetTool?.type !== "tool_never_executed" ||
      finalStatus?.type !== "final_status" ||
      (finalStatus.status !== "completed" &&
        finalStatus.status !== "failed" &&
        finalStatus.status !== "suspended")
    ) {
      throw new Error("redteam_trajectory_missing");
    }
    return {
      taskId: task.id,
      response: { toolId: targetTool.toolId, args: {} },
      expectedStatus: finalStatus.status,
    };
  });
}

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "synthetic",
    model: "redteam",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function createScriptedModel(testCase: ScriptedAttack): ModelPort {
  let attempted = false;
  return {
    complete: () => {
      if (attempted) {
        return Promise.resolve(completion([{ type: "text", text: "Attempt blocked." }]));
      }
      attempted = true;
      return Promise.resolve(
        completion([
          {
            type: "tool_call",
            callId: Id.parse("00000000000000000000000001"),
            toolId: Code.parse(testCase.response.toolId),
            args: testCase.response.args,
          },
        ]),
      );
    },
  };
}

function createContext(): CliContext {
  return {
    loadConfig: () => Promise.resolve(HarnessConfigSchema.parse({})),
    out: createOutput({ stdout: () => undefined, stderr: () => undefined }),
    clock: { now: () => 1_234 },
  };
}

afterEach(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

it("runs the red-team eval suite through CLI cassette replay with safe metadata-only grades", async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-redteam-eval-"));
  const parsedSuite = await evalApi.loadSuite(suiteSourcePath);
  const testCases = scriptedAttacks(parsedSuite);
  const casesByTask = new Map(testCases.map((testCase) => [testCase.taskId, testCase]));
  const suitePath = join(temporaryDirectory, "suite.json");
  await writeFile(suitePath, JSON.stringify(parsedSuite), "utf8");

  const recordDependencies: EvalCommandDependencies = {
    createExecutor: (api) =>
      new api.InProcessExecutor({
        model: (trial) => {
          const testCase = casesByTask.get(trial.task.id);
          if (testCase === undefined) {
            throw new Error("redteam_case_missing");
          }
          return createScriptedModel(testCase);
        },
      }),
  };
  const modelArgs = ["--model", "openai/redteam", "--isolation", "inprocess"];
  const recordExit = await main(
    [
      "eval",
      "run",
      suitePath,
      ...modelArgs,
      "--cassette",
      "record",
      "--fail-under",
      "1",
      "--out",
      join(temporaryDirectory, "record"),
    ],
    createContext(),
    [createEvalCommand(recordDependencies)],
  );
  const replayOutput = join(temporaryDirectory, "replay");
  const replayExit = await main(
    [
      "eval",
      "run",
      suitePath,
      ...modelArgs,
      "--cassette",
      "replay",
      "--fail-under",
      "1",
      "--out",
      replayOutput,
    ],
    createContext(),
    [createEvalCommand()],
  );
  const report = parseJson(
    evalApi.EvalReportSchema,
    await readFile(join(replayOutput, "eval-report.json"), "utf8"),
  );
  const recordReport = parseJson(
    evalApi.EvalReportSchema,
    await readFile(join(temporaryDirectory, "record", "eval-report.json"), "utf8"),
  );

  expect(
    recordReport.trials
      .map(({ taskId, status, graders }) => ({
        taskId,
        status,
        failedGraders: graders
          .filter(({ pass }) => !pass)
          .map(({ graderId, codes }) => ({ graderId, codes })),
      }))
      .sort((left, right) => left.taskId.localeCompare(right.taskId)),
  ).toEqual(
    testCases
      .map(({ taskId, expectedStatus }) => ({
        taskId,
        status: expectedStatus,
        failedGraders: [],
      }))
      .sort((left, right) => left.taskId.localeCompare(right.taskId)),
  );
  expect(recordExit).toBe(ExitCode.ok);
  expect(replayExit).toBe(ExitCode.ok);
  expect(report.invariantsEnabled).toBe(true);
  expect(report.trials).toHaveLength(testCases.length);
  for (const testCase of testCases) {
    const trial = report.trials.find(({ taskId }) => taskId === testCase.taskId);
    expect(trial?.status).toBe(testCase.expectedStatus);
    expect(trial?.graders).toEqual(
      expect.arrayContaining([
        { graderId: "approval_integrity", pass: true, codes: [] },
        { graderId: "no_denied_executed", pass: true, codes: [] },
        { graderId: "trajectory", pass: true, codes: [] },
      ]),
    );
    for (const grader of trial?.graders ?? []) {
      expect(grader.codes.every((code) => /^[a-z0-9_.-]+$/u.test(code))).toBe(true);
    }
  }
  expect(JSON.stringify(report)).not.toContain("Attempt blocked.");
});
