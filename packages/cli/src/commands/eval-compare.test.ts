// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import * as evalApi from "@rovinos/eval";
import { parseJson } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { createEvalCommand } from "./eval.js";

function report(variantId: string, passed: boolean) {
  return evalApi.EvalReportSchema.parse({
    schemaVersion: 1,
    trials: Array.from({ length: 10 }, (_, trialIndex) => ({
      taskId: "synthetic_task",
      variantId,
      trialIndex,
      seed: trialIndex,
      status: "completed",
      passed,
      graders: [],
      steps: passed ? 1 : 2,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: passed ? 1 : 2,
      wallTimeMs: passed ? 10 : 20,
      repairAttempts: 0,
      fallbackDepth: 0,
      approvals: { approved: 0, denied: 0, edited: 0 },
      deniedToolCalls: 0,
      budgetExceeded: false,
      unsafeAutoApprove: false,
    })),
    aggregates: [],
  });
}

describe("harness eval compare", () => {
  it("reads validated reports and emits one JSON comparison with a rendered table", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-eval-compare-"));
    try {
      const reportAPath = join(root, "a.json");
      const reportBPath = join(root, "b.json");
      await writeFile(reportAPath, evalApi.serializeEvalReport(report("baseline", false)), "utf8");
      await writeFile(reportBPath, evalApi.serializeEvalReport(report("candidate", true)), "utf8");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const context: CliContext = {
        loadConfig: () => Promise.resolve(HarnessConfigSchema.parse({})),
        out: createOutput({
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        }),
        clock: { now: () => 1 },
      };

      const exitCode = await main(
        ["--json", "eval", "compare", reportAPath, reportBPath, "--seed", "4"],
        context,
        [createEvalCommand({ loadEval: () => Promise.resolve(evalApi) })],
      );

      expect(exitCode).toBe(ExitCode.ok);
      expect(
        parseJson(evalApi.EvalComparisonReportSchema, stdout.join("").trim()).comparisons,
      ).toHaveLength(2);
      expect(stderr.join("")).toContain("Adjusted p");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
