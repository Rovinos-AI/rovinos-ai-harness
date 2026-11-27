// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { HarnessError, parseJson } from "@rovinos/schemas";
import type { CliContext } from "../command.js";
import type { EvalCommandDependencies } from "./eval.js";

class EvalBaselineError extends HarnessError {
  override readonly code: "usage" | "eval_baseline_failed";

  constructor(code: "usage" | "eval_baseline_failed") {
    super(code);
    this.code = code;
  }
}

function parseMaxDrop(value: string): number {
  const parsed = Number(value);
  if (value.trim().length === 0 || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new EvalBaselineError("usage");
  }
  return parsed;
}

async function updateBaseline(
  reportPath: string,
  baselinePath: string,
  context: CliContext,
  dependencies: EvalCommandDependencies,
): Promise<void> {
  const api = await (dependencies.loadEval ?? (() => import("@rovinos/eval")))();
  const report = parseJson(api.EvalReportSchema, await readFile(resolve(reportPath), "utf8"));
  const baseline = api.buildEvalBaseline(report);
  await writeFile(resolve(baselinePath), api.serializeEvalBaseline(baseline), "utf8");
  context.out.print("eval_baseline_updated\n");
  context.out.json(api.EvalBaselineUpdateSchema, { updated: true });
}

async function checkBaseline(
  reportPath: string,
  options: { readonly baseline: string; readonly maxDrop: string },
  context: CliContext,
  dependencies: EvalCommandDependencies,
): Promise<void> {
  const api = await (dependencies.loadEval ?? (() => import("@rovinos/eval")))();
  const report = parseJson(api.EvalReportSchema, await readFile(resolve(reportPath), "utf8"));
  const baseline = parseJson(
    api.EvalBaselineSchema,
    await readFile(resolve(options.baseline), "utf8"),
  );
  const result = api.checkEvalBaseline(baseline, report, parseMaxDrop(options.maxDrop));
  if (result.regressions.length === 0) {
    context.out.print("eval_baseline_ok\n");
  } else {
    context.out.table([
      ["Code", "Task", "Variant", "Baseline pass rate", "Current pass rate"],
      ...result.regressions.map((regression) => [
        regression.code,
        regression.taskId,
        regression.variantId,
        regression.baselinePassRate ?? "-",
        regression.currentPassRate ?? "-",
      ]),
    ]);
  }
  context.out.json(api.EvalBaselineCheckSchema, result);
  if (!result.passed) {
    throw new EvalBaselineError("eval_baseline_failed");
  }
}

/** Registers baseline update and regression-check commands under `harness eval`. */
export function registerEvalBaselineCommands(
  command: Command,
  context: CliContext,
  dependencies: EvalCommandDependencies,
): void {
  command
    .command("baseline")
    .description("Manage the accepted evaluation baseline")
    .command("update <report>")
    .description("Write a metadata-only baseline from an evaluation report")
    .option("--baseline <file>", "baseline file", "evals/baseline.json")
    .action((reportPath: string, options: { baseline: string }) =>
      updateBaseline(reportPath, options.baseline, context, dependencies),
    );
  command
    .command("check-baseline <report>")
    .description("Check a report against the accepted evaluation baseline")
    .option("--baseline <file>", "baseline file", "evals/baseline.json")
    .option("--max-drop <rate>", "maximum pass-rate drop", "0.05")
    .action((reportPath: string, options: { baseline: string; maxDrop: string }) =>
      checkBaseline(reportPath, options, context, dependencies),
    );
}
