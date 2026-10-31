// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import * as evalApi from "@rovinos/eval";
import type { ModelPort } from "@rovinos/core";
import { CassetteFileSchema } from "@rovinos/models";
import { parseJson } from "@rovinos/schemas";
import { afterEach, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { createEvalCommand } from "./eval.js";
import type { EvalCommandDependencies } from "./eval.js";

let root: string | undefined;

async function setup(): Promise<{ suitePath: string; context: CliContext; output: string }> {
  root = await mkdtemp(join(tmpdir(), "harness-eval-cassette-cli-"));
  const suitePath = join(root, "suite.json");
  await writeFile(
    suitePath,
    JSON.stringify({
      schemaVersion: 1,
      tasks: [
        {
          id: "offline_task",
          input: { goal: "Return the synthetic result." },
          graders: [],
          tags: [],
        },
      ],
    }),
    "utf8",
  );
  const context: CliContext = {
    loadConfig: () => Promise.resolve(HarnessConfigSchema.parse({})),
    out: createOutput({ stdout: () => undefined, stderr: () => undefined }),
    clock: { now: () => 1_234 },
  };
  return { suitePath, context, output: join(root, "reports") };
}

function responseModel(calls: { count: number }): ModelPort {
  return {
    complete: () => {
      calls.count += 1;
      return Promise.resolve({
        provider: "synthetic",
        model: "synthetic",
        parts: [{ type: "text", text: "synthetic result" }],
        providerBlobs: null,
        usage: { inputTokens: 2, outputTokens: 3, costMicros: 4 },
        finishReason: "stop",
        latencyMs: 1,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
      });
    },
  };
}

afterEach(async () => {
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

it("records and replays two variants across five trials without a provider during replay", async () => {
  const { suitePath, context, output } = await setup();
  const providerCalls = { count: 0 };
  const recordDependencies: EvalCommandDependencies = {
    createExecutor: (api) =>
      new api.InProcessExecutor({
        model: () => responseModel(providerCalls),
      }),
  };
  const recordExit = await main(
    [
      "eval",
      "run",
      suitePath,
      "--model",
      "openai/a,openai/b",
      "--trials",
      "5",
      "--cassette",
      "record",
      "--isolation",
      "inprocess",
      "--out",
      output,
    ],
    context,
    [createEvalCommand(recordDependencies)],
  );
  const cassetteDir = join(root ?? "", "cassettes", "offline_task");
  const cassettePaths = await readdir(cassetteDir);

  expect(recordExit).toBe(ExitCode.ok);
  expect(providerCalls.count).toBeGreaterThan(0);
  expect(cassettePaths).toEqual(["model_1.json", "model_2.json"]);
  for (const variant of ["model_1", "model_2"]) {
    const cassette = parseJson(
      CassetteFileSchema,
      await readFile(join(cassetteDir, `${variant}.json`), "utf8"),
    );
    expect(cassette.entries.length).toBeGreaterThan(0);
  }

  const callsAfterRecord = providerCalls.count;
  const replayExit = await main(
    [
      "eval",
      "run",
      suitePath,
      "--model",
      "openai/a,openai/b",
      "--trials",
      "5",
      "--cassette",
      "replay",
      "--out",
      join(root ?? "", "replay"),
    ],
    context,
    [createEvalCommand()],
  );
  const records = (await readFile(join(root ?? "", "replay", "trials.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => parseJson(evalApi.EvalTrialRecordSchema, line));
  const report = parseJson(
    evalApi.EvalReportSchema,
    await readFile(join(root ?? "", "replay", "eval-report.json"), "utf8"),
  );

  expect(replayExit).toBe(ExitCode.ok);
  expect(providerCalls.count).toBe(callsAfterRecord);
  expect(records).toHaveLength(10);
  expect(new Set(records.map(({ variantId }) => variantId))).toEqual(
    new Set(["model_1", "model_2"]),
  );
  expect(records.every(({ result }) => result.status === "completed")).toBe(true);
  expect(report.aggregates).toHaveLength(2);
});

it("fails a missing replay cassette with cassette_miss without dispatching a provider", async () => {
  const { suitePath, context, output } = await setup();
  const calls = { count: 0 };
  const exitCode = await main(
    ["eval", "run", suitePath, "--model", "openai/a", "--cassette", "replay", "--out", output],
    context,
    [createEvalCommand()],
  );
  const trialJsonl = await readFile(join(output, "trials.jsonl"), "utf8");

  expect(exitCode).toBe(ExitCode.ok);
  expect(calls.count).toBe(0);
  expect(trialJsonl).toContain('"status":"failed"');
  expect(trialJsonl).toContain('"errorCode":"cassette_miss"');
});
