// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import * as evalApi from "@rovinos/eval";
import { afterEach, describe, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { createEvalCommand } from "./eval.js";

let temporaryDirectory: string | undefined;

function createReport(passRate = 1): evalApi.EvalReport {
  return evalApi.EvalReportSchema.parse({
    schemaVersion: 1,
    trials: [
      {
        taskId: "task_one",
        variantId: "baseline",
        trialIndex: 0,
        status: "completed",
        passed: true,
        graders: [{ graderId: "no_canary_leak", pass: true, codes: [] }],
        steps: 1,
        inputTokens: 2,
        outputTokens: 3,
        costMicros: 4,
        wallTimeMs: 5,
        repairAttempts: 0,
        fallbackDepth: 0,
        approvals: { approved: 0, denied: 0, edited: 0 },
        deniedToolCalls: 0,
        budgetExceeded: false,
        unsafeAutoApprove: false,
      },
    ],
    aggregates: [
      {
        taskId: "task_one",
        variantId: "baseline",
        n: 1,
        passes: passRate === 1 ? 1 : 0,
        passRate,
        standardError: 0,
        passAtK: [{ k: 1, rate: passRate }],
        costMicros: { mean: 4, median: 4, p95: 4 },
        inputTokens: { mean: 2, median: 2, p95: 2 },
        outputTokens: { mean: 3, median: 3, p95: 3 },
        totalTokens: { mean: 5, median: 5, p95: 5 },
        steps: { mean: 1, median: 1, p95: 1 },
        latencyMs: { mean: 5, median: 5, p95: 5 },
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

async function setupFiles(passRate = 1) {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-eval-baseline-"));
  const reportPath = join(temporaryDirectory, "report.json");
  const baselinePath = join(temporaryDirectory, "baseline.json");
  await writeFile(reportPath, evalApi.serializeEvalReport(createReport(passRate)), "utf8");
  await writeFile(
    baselinePath,
    evalApi.serializeEvalBaseline(evalApi.buildEvalBaseline(createReport())),
    "utf8",
  );
  return { reportPath, baselinePath };
}

afterEach(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("harness eval baseline", () => {
  it("updates a baseline deterministically", async () => {
    const { reportPath, baselinePath } = await setupFiles();
    const command = createEvalCommand({ loadEval: () => Promise.resolve(evalApi) });
    const args = ["eval", "baseline", "update", reportPath, "--baseline", baselinePath];
    expect(await main(args, createContext(), [command])).toBe(ExitCode.ok);
    const updated = await readFile(baselinePath, "utf8");
    expect(await main(args, createContext(), [command])).toBe(ExitCode.ok);
    expect(await readFile(baselinePath, "utf8")).toBe(updated);
  });

  it("returns success within the maximum pass-rate drop", async () => {
    const { reportPath, baselinePath } = await setupFiles(0.96);
    const command = createEvalCommand({ loadEval: () => Promise.resolve(evalApi) });
    expect(
      await main(
        ["eval", "check-baseline", reportPath, "--baseline", baselinePath, "--max-drop", "0.05"],
        createContext(),
        [command],
      ),
    ).toBe(ExitCode.ok);
  });

  it("returns failure when the maximum pass-rate drop is exceeded", async () => {
    const { reportPath, baselinePath } = await setupFiles(0.9);
    const command = createEvalCommand({ loadEval: () => Promise.resolve(evalApi) });
    expect(
      await main(
        ["eval", "check-baseline", reportPath, "--baseline", baselinePath, "--max-drop", "0.05"],
        createContext(),
        [command],
      ),
    ).toBe(ExitCode.failure);
  });
});
