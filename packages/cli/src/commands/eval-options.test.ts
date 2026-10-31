// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import * as evalApi from "@rovinos/eval";
import type { TrialExecutor } from "@rovinos/eval";
import { Id, parseJson } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { createEvalCommand } from "./eval.js";
import type { EvalCommandDependencies } from "./eval.js";
import { createVariants, filterSuite, nonnegativeNumber, positiveInteger } from "./eval-options.js";

const config = HarnessConfigSchema.parse({});
const suite = evalApi.EvalSuiteSchema.parse({
  schemaVersion: 1,
  tasks: [
    { id: "first", input: { goal: "synthetic" }, graders: [], tags: ["smoke"] },
    { id: "second", input: { goal: "synthetic" }, graders: [], tags: ["full"] },
  ],
});

describe("eval option parsing", () => {
  it("validates integer and non-negative numeric options", () => {
    expect(positiveInteger("5")).toBe(5);
    expect(positiveInteger("0", true)).toBe(0);
    expect(() => positiveInteger("0")).toThrow();
    expect(() => positiveInteger("-1", true)).toThrow();
    expect(() => positiveInteger("1.5")).toThrow();
    expect(() => positiveInteger("9007199254740992")).toThrow();

    expect(nonnegativeNumber("0.25")).toBe(0.25);
    expect(() => nonnegativeNumber("-0.1")).toThrow();
    expect(() => nonnegativeNumber("Infinity")).toThrow();
  });

  it("creates default and selected model variants with cassette configuration", () => {
    expect(createVariants(evalApi, undefined, "replay", config)).toEqual([
      { id: "default", cassetteMode: "replay" },
    ]);
    expect(createVariants(evalApi, undefined, "off", config)).toEqual([{ id: "default" }]);
    expect(createVariants(evalApi, "provider/one,provider/two", "record", config)).toEqual([
      {
        id: "model_1",
        models: [{ provider: "provider", model: "one" }],
        cassetteMode: "record",
      },
      {
        id: "model_2",
        models: [{ provider: "provider", model: "two" }],
        cassetteMode: "record",
      },
    ]);
    expect(createVariants(evalApi, "one", "off", config)[0]?.models).toEqual([
      { provider: "openai", model: "one" },
    ]);
    for (const invalid of ["", "/", "/model", "provider/", "bad provider/model"]) {
      expect(() => createVariants(evalApi, invalid, "off", config)).toThrow();
    }
  });

  it("selects tasks by id or tag and rejects an empty selection", () => {
    expect(filterSuite(evalApi, suite, undefined)).toBe(suite);
    expect(filterSuite(evalApi, suite, "first").tasks.map(({ id }) => id)).toEqual(["first"]);
    expect(filterSuite(evalApi, suite, "full").tasks.map(({ id }) => id)).toEqual(["second"]);
    expect(() => filterSuite(evalApi, suite, "missing")).toThrow(
      expect.objectContaining({ code: "eval_filter_empty" }),
    );
  });

  it("runs a filtered task with default replay cassette and in-process isolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-eval-options-cli-"));
    try {
      const suitePath = join(root, "suite.json");
      const output = join(root, "reports");
      await writeFile(
        suitePath,
        JSON.stringify({
          schemaVersion: 1,
          tasks: [
            { id: "selected", input: { goal: "synthetic" }, graders: [], tags: ["smoke"] },
            { id: "filtered", input: { goal: "synthetic" }, graders: [], tags: ["other"] },
          ],
        }),
        "utf8",
      );
      const context: CliContext = {
        loadConfig: () => Promise.resolve(config),
        out: createOutput({ stdout: () => undefined, stderr: () => undefined }),
        clock: { now: () => 1 },
      };
      const selectedTasks: string[] = [];
      let executorOptions:
        Parameters<NonNullable<EvalCommandDependencies["createExecutor"]>>[1] | undefined;
      const executor: TrialExecutor = {
        run: (trial) => {
          selectedTasks.push(trial.task.id);
          return Promise.resolve(
            evalApi.TrialResultSchema.parse({
              status: "completed",
              runId: Id.parse("00000000000000000000000001"),
              dbPath: join(trial.workDir, "data", "harness.db"),
              workspaceDir: join(trial.workDir, "workspace"),
              durationMs: 1,
              usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
              exitCode: 0,
            }),
          );
        },
        eventsFor: () => [],
      };
      const dependencies: EvalCommandDependencies = {
        createExecutor: (_api, options) => {
          executorOptions = options;
          return executor;
        },
      };
      const exitCode = await main(
        ["eval", "run", suitePath, "--filter", "smoke", "--out", output],
        context,
        [createEvalCommand(dependencies)],
      );
      const report = parseJson(
        evalApi.EvalTrialRecordSchema,
        await readFile(join(output, "trials.jsonl"), "utf8"),
      );

      expect(exitCode).toBe(ExitCode.ok);
      expect(selectedTasks).toEqual(["selected"]);
      expect(executorOptions).toMatchObject({
        isolation: "inprocess",
        cassette: "replay",
        exportTelemetry: false,
      });
      expect(report.taskId).toBe("selected");
      expect(
        await main(["eval", "run", suitePath, "--isolation", "remote"], context, [
          createEvalCommand(dependencies),
        ]),
      ).toBe(ExitCode.usage);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
