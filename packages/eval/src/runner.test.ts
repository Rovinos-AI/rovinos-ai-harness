// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Id, parseJson } from "@harness/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { defineSuite } from "./load.js";
import { runEval } from "./runner.js";
import type { TrialExecutor } from "./executor.js";
import { TrialResultSchema } from "./trial.js";
import type { TrialResult, TrialSpec } from "./trial.js";

const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "harness-eval-runner-"));
  directories.push(path);
  return path;
}

function makeSuite() {
  return defineSuite({
    schemaVersion: 1,
    tasks: [
      { id: "task_one", input: { goal: "Goal one." }, graders: [], tags: [], trials: 1 },
      { id: "task_two", input: { goal: "Goal two." }, graders: [], tags: [], trials: 1 },
    ],
  });
}

function resultFor(trial: TrialSpec, status: TrialResult["status"] = "completed"): TrialResult {
  return {
    status,
    ...(status === "error" ? { errorCode: "synthetic_error" } : {}),
    runId: Id.parse("00000000000000000000000001"),
    dbPath: join(trial.workDir, "data", "harness.db"),
    workspaceDir: join(trial.workDir, "workspace"),
    durationMs: 1,
    usage: { inputTokens: 1, outputTokens: 2, costMicros: 3 },
    exitCode: status === "completed" ? 0 : 1,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("runEval", () => {
  it("bounds concurrency, streams results, records failures, and returns plan order", async () => {
    const outDir = await createDirectory();
    let active = 0;
    let maxActive = 0;
    let streamedBeforeFinish = false;
    const executor: TrialExecutor = {
      run: async (trial) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (trial.task.id === "task_one") {
            await new Promise((resolve) => setTimeout(resolve, trial.trialIndex === 0 ? 30 : 1));
          }
          if (trial.task.id === "task_two" && trial.trialIndex === 0) {
            const current = await readFile(join(outDir, "trials.jsonl"), "utf8");
            streamedBeforeFinish = current.trim().length > 0;
          }
          if (trial.task.id === "task_two" && trial.trialIndex === 0) {
            throw Object.assign(new Error("synthetic failure"), { code: "synthetic_crash" });
          }
          return resultFor(trial);
        } finally {
          active -= 1;
        }
      },
    };
    const results = await runEval(makeSuite(), [{ id: "baseline" }], executor, {
      outDir,
      concurrency: 2,
      trials: 2,
      seed: 7,
    });
    const lines = (await readFile(join(outDir, "trials.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => parseJson(TrialResultSchema, line));
    const resultFile = await readFile(join(outDir, "trials.jsonl"), "utf8");

    expect(maxActive).toBe(2);
    expect(streamedBeforeFinish).toBe(true);
    expect(results).toHaveLength(4);
    expect(results[0]?.status).toBe("completed");
    expect(results[1]?.status).toBe("completed");
    expect(results[2]).toMatchObject({ status: "error", errorCode: "synthetic_crash" });
    expect(resultFile).not.toContain("synthetic failure");
    expect(new Set(results.map(({ dbPath }) => dbPath)).size).toBe(4);
    expect(lines).toHaveLength(4);
    expect(lines[0]?.workspaceDir).toBe(results[1]?.workspaceDir);
    expect(lines.at(-1)?.workspaceDir).toBe(results[0]?.workspaceDir);
  });

  it("rejects duplicate variant ids before starting trials", async () => {
    await expect(
      runEval(
        makeSuite(),
        [{ id: "same" }, { id: "same" }],
        { run: (trial) => Promise.resolve(resultFor(trial)) },
        { outDir: await createDirectory() },
      ),
    ).rejects.toThrow("eval_variant_id_duplicate");
  });
});
