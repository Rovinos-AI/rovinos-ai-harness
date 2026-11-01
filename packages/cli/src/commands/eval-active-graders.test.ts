// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import * as core from "@rovinos/core";
import type { ModelPort } from "@rovinos/core";
import { allowAllPolicy } from "@rovinos/core/testing";
import * as evalApi from "@rovinos/eval";
import { CassetteFileSchema } from "@rovinos/models";
import type { ProviderAdapter } from "@rovinos/models";
import { Id, parseJson } from "@rovinos/schemas";
import { afterEach, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { ExitCode } from "../exit-codes.js";
import { createEvalCommand } from "./eval.js";
import type { EvalCommandDependencies } from "./eval.js";

let root: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

const model: ModelPort = {
  complete: () =>
    Promise.resolve({
      provider: "synthetic",
      model: "synthetic",
      parts: [{ type: "text", text: "synthetic answer" }],
      providerBlobs: null,
      usage: { inputTokens: 2, outputTokens: 3, costMicros: 4 },
      finishReason: "stop",
      latencyMs: 1,
      schemaValid: true,
      repairAttempts: 0,
      fallbackDepth: 0,
    }),
};

function agentModel(): ModelPort {
  let calls = 0;
  return {
    complete: async (request, context) => {
      const response = await model.complete(request, context);
      calls += 1;
      if (calls !== 1) {
        return response;
      }
      return {
        ...response,
        finishReason: "tool_calls",
        parts: [
          {
            type: "tool_call",
            callId: Id.parse("00000000000000000000000011"),
            toolId: "fs.write",
            args: { path: "agent.txt", content: "synthetic agent output", mode: "create" },
          },
        ],
      };
    },
  };
}

async function setup(
  graders: readonly unknown[],
  maxRepairs = 0,
  canaries: readonly string[] = [],
) {
  root = await mkdtemp(join(process.cwd(), ".eval-active-"));
  const fixture = join(root, "fixture");
  await mkdir(fixture);
  await writeFile(join(fixture, "answer.txt"), "synthetic fixture");
  const suite = join(root, "suite.json");
  await writeFile(
    suite,
    JSON.stringify({
      schemaVersion: 1,
      tasks: [
        {
          id: "synthetic_task",
          input: { goal: "synthetic goal" },
          workspace: { fixtureDir: fixture },
          graders,
          ...(canaries.length === 0 ? {} : { canaries }),
          tags: [],
        },
      ],
    }),
  );
  const secrets = vi.fn(() => Promise.reject(new Error("live_secret_resolution_forbidden")));
  const context: CliContext = {
    loadConfig: () =>
      Promise.resolve(
        HarnessConfigSchema.parse({
          models: {
            providers: [{ id: "openai", kind: "openai", apiKey: "env:EVAL_SYNTHETIC_KEY" }],
            pricing: {
              "openai/judge": { inputMicrosPerMTok: 1_000_000_000_000, outputMicrosPerMTok: 0 },
            },
            retry: { maxAttempts: 1 },
            enforcement: { maxRepairs },
          },
        }),
      ),
    secretResolver: { resolve: secrets },
    clock: { now: () => 1234 },
    out: createOutput({ stdout: () => undefined, stderr: () => undefined }),
  };
  return { suite, context, secrets };
}

async function report(path: string) {
  return parseJson(
    evalApi.EvalReportSchema,
    await readFile(join(path, "eval-report.json"), "utf8"),
  );
}

const judge = {
  type: "llm_judge",
  rubricId: "synthetic_rubric",
  rubric: "- id: criterion\n  description: synthetic criterion\n  weight: 1",
  model: { provider: "openai", model: "judge" },
  passThreshold: 1,
  votes: 3,
};

it("grades fixture and agent-written files in isolated runtime projects without host credentials", async () => {
  const { suite, context } = await setup([
    {
      type: "test_command",
      argv: [
        process.execPath,
        "-e",
        "const fs=require('fs'); if(fs.readFileSync('answer.txt','utf8')!=='synthetic fixture'||fs.readFileSync('agent.txt','utf8')!=='synthetic agent output'||process.env.EVAL_SYNTHETIC_CREDENTIAL)process.exit(2); fs.writeFileSync('graded.txt','synthetic output');",
      ],
    },
    { type: "file_diff", path: "answer.txt", expectedContains: "synthetic fixture" },
    { type: "file_diff", path: "agent.txt", expectedContains: "synthetic agent output" },
  ]);
  const output = join(root ?? "", "out");
  vi.stubEnv("EVAL_SYNTHETIC_CREDENTIAL", "synthetic-not-a-secret");
  try {
    const result = await main(["eval", "run", suite, "--trials", "2", "--out", output], context, [
      createEvalCommand({
        createExecutor: () =>
          new evalApi.InProcessExecutor({ model: agentModel, policy: () => allowAllPolicy }),
      }),
    ]);
    expect(result).toBe(ExitCode.ok);
    const metadata = await report(output);
    expect(metadata.trials.every((trial) => trial.passed)).toBe(true);
    const records = evalApi.parseEvalTrialJsonl(
      await readFile(join(output, "trials.jsonl"), "utf8"),
    );
    expect(new Set(records.map((record) => record.result.workspaceDir)).size).toBe(2);
    for (const record of records) {
      expect(record.result.workspaceDir).toContain("/data/workspaces/");
      expect(await readFile(join(record.result.workspaceDir, "agent.txt"), "utf8")).toBe(
        "synthetic agent output",
      );
      expect(await readFile(join(record.result.workspaceDir, "graded.txt"), "utf8")).toBe(
        "synthetic output",
      );
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

it("checks privacy after command graders finish writing trial artifacts", async () => {
  const canary = "synthetic-grading-canary@example.test";
  const { suite, context } = await setup(
    [
      { type: "no_canary_leak" },
      {
        type: "test_command",
        argv: [
          process.execPath,
          "-e",
          `require('fs').writeFileSync('grader-output.txt', ${JSON.stringify(canary)})`,
        ],
      },
    ],
    0,
    [canary],
  );
  const output = join(root ?? "", "privacy");
  expect(
    await main(["eval", "run", suite, "--out", output, "--fail-under", "1"], context, [
      createEvalCommand({
        createExecutor: () => new evalApi.InProcessExecutor({ model: () => model }),
      }),
    ]),
  ).toBe(ExitCode.failure);
  const metadata = await report(output);
  expect(metadata.trials[0]?.graders[0]?.codes).toContain("canary_in_workspace_unexpected");
  expect(metadata.trials[0]?.graders[1]?.pass).toBe(true);
  expect(JSON.stringify(metadata)).not.toContain(canary);
});

it("records and replays voted judges with configured pricing and stops scheduling at judge cost", async () => {
  const { suite, context, secrets } = await setup([judge]);
  let callNumber = 0;
  const complete = vi.fn<ProviderAdapter["complete"]>(() => {
    callNumber += 1;
    return Promise.resolve({
      parts: [
        {
          type: "text",
          text:
            callNumber === 3
              ? '{"criteria":[{"id":"criterion","met":false}],"verdict":"fail"}'
              : '{"criteria":[{"id":"criterion","met":true}],"verdict":"pass"}',
        },
      ],
      usage: { inputTokens: 2, outputTokens: 1 },
      finishReason: "stop",
      latencyMs: 1,
    });
  });
  const adapter: ProviderAdapter = { provider: "openai", kind: "openai", complete };
  const original = core.createConfiguredModelPort;
  const configured = vi
    .spyOn(core, "createConfiguredModelPort")
    .mockImplementation((config, overrides) =>
      original(config, { ...overrides, providerAdapters: [adapter] }),
    );
  const output = join(root ?? "", "record");
  const dependencies: EvalCommandDependencies = {
    createExecutor: () => new evalApi.InProcessExecutor({ model: () => model }),
  };
  const exit = await main(
    [
      "eval",
      "run",
      suite,
      "--cassette",
      "record",
      "--isolation",
      "inprocess",
      "--trials",
      "3",
      "--concurrency",
      "1",
      "--max-cost-usd",
      "1",
      "--out",
      output,
    ],
    context,
    [createEvalCommand(dependencies)],
  );
  expect(exit).toBe(ExitCode.budgetExceeded);
  expect(complete).toHaveBeenCalledTimes(3);
  expect(configured.mock.calls[0]?.[0]?.routing.roles).toEqual({ judge: [judge.model] });
  const records = evalApi.parseEvalTrialJsonl(await readFile(join(output, "trials.jsonl"), "utf8"));
  expect(records.map((record) => record.result.status)).toEqual([
    "completed",
    "skipped_budget",
    "skipped_budget",
  ]);
  expect(records[0]?.result.usage).toEqual({
    inputTokens: 8,
    outputTokens: 6,
    costMicros: 6_000_004,
  });
  expect((await report(output)).trials[0]?.costMicros).toBe(6_000_004);
  const cassette = parseJson(
    CassetteFileSchema,
    await readFile(join(root ?? "", "cassettes", "synthetic_task", "default.judge.json"), "utf8"),
  );
  expect(JSON.stringify(cassette)).not.toContain("synthetic goal");
  expect(cassette.entries).toHaveLength(3);
  configured.mockRestore();
  const replay = join(root ?? "", "replay");
  expect(await main(["eval", "run", suite, "--out", replay], context, [createEvalCommand()])).toBe(
    ExitCode.ok,
  );
  expect((await report(replay)).trials[0]?.passed).toBe(true);
  expect(complete).toHaveBeenCalledTimes(3);
  expect(secrets).not.toHaveBeenCalled();
  await rm(join(root ?? "", "cassettes", "synthetic_task", "default.judge.json"));
  const missing = join(root ?? "", "missing");
  expect(
    await main(["eval", "run", suite, "--out", missing, "--fail-under", "1"], context, [
      createEvalCommand(),
    ]),
  ).toBe(ExitCode.failure);
  expect((await report(missing)).trials[0]?.graders).toContainEqual({
    graderId: "llm_judge",
    pass: false,
    codes: ["cassette_miss", "judge_error"],
  });
  expect(secrets).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledTimes(3);
});

it("keeps malformed judge output off disk while charging failed verdict usage", async () => {
  const { suite, context } = await setup([judge]);
  const original = core.createConfiguredModelPort;
  vi.spyOn(core, "createConfiguredModelPort").mockImplementation((config, overrides) =>
    original(config, {
      ...overrides,
      providerAdapters: [
        {
          provider: "openai",
          kind: "openai",
          complete: () =>
            Promise.resolve({
              parts: [{ type: "text", text: '{"reason":"synthetic private reasoning"}' }],
              usage: { inputTokens: 2, outputTokens: 1 },
              finishReason: "stop",
              latencyMs: 1,
            }),
        },
      ],
    }),
  );
  const output = join(root ?? "", "invalid");
  expect(
    await main(
      ["eval", "run", suite, "--cassette", "record", "--isolation", "inprocess", "--out", output],
      context,
      [
        createEvalCommand({
          createExecutor: () => new evalApi.InProcessExecutor({ model: () => model }),
        }),
      ],
    ),
  ).toBe(ExitCode.ok);
  expect((await report(output)).trials[0]?.graders).toContainEqual({
    graderId: "llm_judge",
    pass: false,
    codes: ["judge_error"],
  });
  expect((await report(output)).trials[0]?.costMicros).toBe(2_000_004);
  await expect(
    readFile(join(root ?? "", "cassettes", "synthetic_task", "default.judge.json"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("replays repaired judge verdicts under the original vote identity with all attempt usage", async () => {
  const { suite, context, secrets } = await setup([judge], 1);
  let callNumber = 0;
  const complete = vi.fn<ProviderAdapter["complete"]>(() => {
    callNumber += 1;
    return Promise.resolve({
      parts: [
        {
          type: "text",
          text:
            callNumber === 1
              ? '{"reason":"synthetic private reasoning"}'
              : '{"criteria":[{"id":"criterion","met":true}],"verdict":"pass"}',
        },
      ],
      usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 1 },
      finishReason: "stop",
      latencyMs: 1,
    });
  });
  const original = core.createConfiguredModelPort;
  const configured = vi
    .spyOn(core, "createConfiguredModelPort")
    .mockImplementation((config, overrides) =>
      original(config, {
        ...overrides,
        providerAdapters: [{ provider: "openai", kind: "openai", complete }],
      }),
    );
  const recorded = join(root ?? "", "repaired-record");
  expect(
    await main(
      ["eval", "run", suite, "--cassette", "record", "--isolation", "inprocess", "--out", recorded],
      context,
      [
        createEvalCommand({
          createExecutor: () => new evalApi.InProcessExecutor({ model: () => model }),
        }),
      ],
    ),
  ).toBe(ExitCode.ok);
  expect(complete).toHaveBeenCalledTimes(4);
  const recordedReport = await report(recorded);
  expect(recordedReport.trials[0]?.passed).toBe(true);
  const cassette = parseJson(
    CassetteFileSchema,
    await readFile(join(root ?? "", "cassettes", "synthetic_task", "default.judge.json"), "utf8"),
  );
  expect(cassette.entries).toHaveLength(3);
  expect(JSON.stringify(cassette)).not.toContain("synthetic private reasoning");
  configured.mockRestore();
  const replayed = join(root ?? "", "repaired-replay");
  expect(
    await main(["eval", "run", suite, "--out", replayed, "--fail-under", "1"], context, [
      createEvalCommand(),
    ]),
  ).toBe(ExitCode.ok);
  const replayedReport = await report(replayed);
  expect(replayedReport.trials[0]?.graders).toEqual(recordedReport.trials[0]?.graders);
  expect(replayedReport.trials[0]?.costMicros).toBe(recordedReport.trials[0]?.costMicros);
  expect(complete).toHaveBeenCalledTimes(4);
  expect(secrets).not.toHaveBeenCalled();
});

it.each(["off", "record", "replay"])(
  "reports an unavailable %s judge gateway as a grade, not a suite rejection",
  async (mode) => {
    const { suite, context } = await setup([judge, { ...judge, rubricId: "second_rubric" }]);
    vi.spyOn(core, "createConfiguredModelPort").mockResolvedValue(undefined);
    const output = join(root ?? "", "unavailable");
    expect(
      await main(
        ["eval", "run", suite, "--cassette", mode, "--isolation", "inprocess", "--out", output],
        context,
        [
          createEvalCommand({
            createExecutor: () => new evalApi.InProcessExecutor({ model: () => model }),
          }),
        ],
      ),
    ).toBe(ExitCode.ok);
    expect(
      (await report(output)).trials[0]?.graders.every((grade) =>
        grade.codes.includes("judge_error"),
      ),
    ).toBe(true);
  },
);
