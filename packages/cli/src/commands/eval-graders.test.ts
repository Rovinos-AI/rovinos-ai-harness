// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessConfigSchema } from "@rovinos/config";
import * as evalApi from "@rovinos/eval";
import { EventSchema, Id, parseJson } from "@rovinos/schemas";
import type { Event } from "@rovinos/schemas";
import type { TrialExecutor, TrialSpec } from "@rovinos/eval";
import { afterEach, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { createEvalCommand } from "./eval.js";
import type { EvalCommandDependencies } from "./eval.js";

let root: string | undefined;

const schemaRef = `${fileURLToPath(new URL("../../../eval/src/graders/schema-fixture.ts", import.meta.url))}#AnswerSchema`;
const syntheticCanary = "synthetic-grade-canary@example.test";

function context(): CliContext {
  return {
    loadConfig: () => Promise.resolve(HarnessConfigSchema.parse({})),
    out: createOutput({ stdout: () => undefined, stderr: () => undefined }),
    clock: { now: () => 1_234 },
  };
}

function trialEvents(taskId: string): readonly Event[] {
  const runId = Id.parse("00000000000000000000000001");
  return [
    EventSchema.parse({
      runId,
      seq: 1,
      ts: 1,
      v: 1,
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      segmentId: runId,
      type: "model_response",
      requestId: Id.parse("00000000000000000000000002"),
      provider: "synthetic",
      model: "synthetic",
      inputTokens: 1,
      outputTokens: 1,
      finishReason: "stop",
      latencyMs: 1,
      schemaValid: true,
      repairAttempts: 0,
      content: [
        {
          type: "text",
          text: taskId === "schema_fail" ? "not json" : '{"answer":"synthetic"}',
        },
      ],
      providerBlobs: null,
    }),
    EventSchema.parse({
      runId,
      seq: 2,
      ts: 2,
      v: 1,
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      segmentId: runId,
      type: "run_status_changed",
      from: "running",
      to: taskId === "trajectory_fail" ? "failed" : "completed",
      reason: "finished",
    }),
  ];
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

it("grades supported deterministic graders through the CLI on pass and failure paths", async () => {
  root = await mkdtemp(join(tmpdir(), "harness-eval-graders-cli-"));
  const suitePath = join(root, "suite.json");
  const output = join(root, "reports");
  const specs = [
    { id: "file_pass", graders: [{ type: "file_diff", path: "answer.txt", expectedContains: "expected" }] },
    { id: "file_fail", graders: [{ type: "file_diff", path: "answer.txt", expectedContains: "missing" }] },
    { id: "file_error", graders: [{ type: "file_diff", path: "throws", expectedContains: "x" }] },
    { id: "canary_pass", graders: [{ type: "no_canary_leak" }], canaries: ["not-in-artifacts"] },
    {
      id: "canary_fail",
      graders: [{ type: "no_canary_leak" }],
      canaries: [syntheticCanary],
    },
    { id: "canary_missing", graders: [{ type: "no_canary_leak" }] },
    {
      id: "canary_error",
      graders: [{ type: "no_canary_leak" }],
      canaries: ["not-in-artifacts"],
    },
    { id: "schema_pass", graders: [{ type: "schema_valid", schemaRef }] },
    { id: "schema_fail", graders: [{ type: "schema_valid", schemaRef }] },
    {
      id: "trajectory_pass",
      graders: [{ type: "trajectory", assertions: [{ type: "final_status", status: "completed" }] }],
    },
    {
      id: "trajectory_fail",
      graders: [{ type: "trajectory", assertions: [{ type: "final_status", status: "completed" }] }],
    },
  ];
  await writeFile(
    suitePath,
    JSON.stringify({
      schemaVersion: 1,
      tasks: specs.map(({ id, graders, canaries }) => ({
        id,
        input: { goal: "synthetic goal" },
        graders,
        ...(canaries === undefined ? {} : { canaries }),
        tags: [],
      })),
    }),
    "utf8",
  );
  const originalFileGrader = evalApi.createFileDiffGrader;
  vi.spyOn(evalApi, "createFileDiffGrader").mockImplementation((spec) => {
    if (spec.path === "throws") {
      throw new Error("synthetic grader error");
    }
    return originalFileGrader(spec);
  });
  const executor: TrialExecutor = {
    run: async (trial: TrialSpec) => {
      const workspaceDir = join(trial.workDir, "workspace");
      if (trial.task.id !== "canary_error") {
        await mkdir(workspaceDir, { recursive: true });
      }
      if (trial.task.id.startsWith("file_") && trial.task.id !== "file_error") {
        await writeFile(join(workspaceDir, "answer.txt"), "expected output", "utf8");
      }
      if (trial.task.id === "canary_fail") {
        await writeFile(join(workspaceDir, "leak.txt"), syntheticCanary, "utf8");
      }
      return evalApi.TrialResultSchema.parse({
        status: "completed",
        runId: Id.parse("00000000000000000000000001"),
        dbPath: join(trial.workDir, "data", "harness.db"),
        workspaceDir,
        durationMs: 1,
        usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
        exitCode: 0,
      });
    },
    eventsFor: (trial) => trialEvents(trial.task.id),
  };
  const dependencies: EvalCommandDependencies = {
    loadEval: () => Promise.resolve(evalApi),
    createExecutor: () => executor,
  };
  const exitCode = await main(
    ["eval", "run", suitePath, "--out", output],
    context(),
    [createEvalCommand(dependencies)],
  );
  const report = parseJson(
    evalApi.EvalReportSchema,
    await readFile(join(output, "eval-report.json"), "utf8"),
  );
  const gradeCodes = new Map(
    report.trials.map((trial) => [
      trial.taskId,
      trial.graders.flatMap((grader) => grader.codes),
    ]),
  );

  expect(exitCode).toBe(ExitCode.ok);
  expect(gradeCodes.get("file_pass")).toEqual([]);
  expect(gradeCodes.get("file_fail")).toEqual(["content_mismatch"]);
  expect(gradeCodes.get("file_error")).toEqual(["grader_execution_failed"]);
  expect(gradeCodes.get("canary_pass")).toEqual([]);
  expect(gradeCodes.get("canary_fail")).toContain("canary_in_workspace_unexpected");
  expect(gradeCodes.get("canary_missing")).toEqual(["canaries_missing"]);
  expect(gradeCodes.get("canary_error")).toEqual(["grader_execution_failed"]);
  expect(gradeCodes.get("schema_pass")).toEqual([]);
  expect(gradeCodes.get("schema_fail")).toEqual(["no_json"]);
  expect(gradeCodes.get("trajectory_pass")).toEqual([]);
  expect(gradeCodes.get("trajectory_fail")).toEqual(["final_status_mismatch"]);
  expect(JSON.stringify(report)).not.toContain(syntheticCanary);
});
