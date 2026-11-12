// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseJson } from "@rovinos/schemas";
import {
  BenchmarkBudgetsSchema,
  BenchmarkResultSchema,
  evaluateBudgets,
  type BenchmarkBudgets,
  type BenchmarkResult,
  type BudgetViolation,
} from "./contracts.js";

export function compareBenchmarkResults(
  budgets: BenchmarkBudgets,
  current: BenchmarkResult,
  baseline?: BenchmarkResult,
  allowMissingBaseline = false,
): BudgetViolation[] {
  return evaluateBudgets(budgets, current, baseline, allowMissingBaseline);
}

export function formatComparison(
  budgets: BenchmarkBudgets,
  result: BenchmarkResult,
  baseline?: BenchmarkResult,
  violations: readonly BudgetViolation[] = [],
): string {
  const metricByName = new Map(result.metrics.map((metric) => [metric.name, metric]));
  const violationByName = new Map(violations.map((violation) => [violation.metric, violation]));
  const rows = [...new Set([...budgets.absolute, ...budgets.relative].map(({ metric }) => metric))]
    .sort()
    .map((name) => {
      const metric = metricByName.get(name);
      const violation = violationByName.get(name);
      const prior = baseline?.metrics.find((entry) => entry.name === name);
      return [
        name,
        metric === undefined ? "missing" : `${metric.value.toFixed(3)} ${metric.unit}`,
        prior === undefined ? "—" : `${prior.value.toFixed(3)} ${prior.unit}`,
        violation?.code ?? "ok",
      ];
    });
  const widths = rows.reduce(
    (currentWidths, row) => row.map((cell, index) => Math.max(currentWidths[index] ?? 0, cell.length)),
    ["metric".length, "current".length, "previous".length, "status".length],
  );
  const render = (row: readonly string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ");
  return [
    render(["metric", "current", "previous", "status"]),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...rows.map(render),
  ].join("\n");
}

interface CliOptions {
  readonly budgets: string;
  readonly result: string;
  readonly baseline?: string;
  readonly allowMissingBaseline: boolean;
}

function parseArgs(args: readonly string[]): CliOptions {
  const options = new Map<string, string>();
  let allowMissingBaseline = false;
  for (const arg of args) {
    if (arg === "--allow-missing-baseline") {
      allowMissingBaseline = true;
      continue;
    }
    const separator = arg.indexOf("=");
    if (separator <= 2 || !arg.startsWith("--")) {
      throw new Error("invalid_arguments");
    }
    options.set(arg.slice(2, separator), arg.slice(separator + 1));
  }
  const budgets = options.get("budgets");
  const result = options.get("result");
  if (budgets === undefined || result === undefined) {
    throw new Error("required_arguments_missing");
  }
  const baseline = options.get("baseline");
  return {
    budgets,
    result,
    ...(baseline === undefined ? {} : { baseline }),
    allowMissingBaseline,
  };
}

async function loadJson<Schema extends typeof BenchmarkBudgetsSchema | typeof BenchmarkResultSchema>(
  path: string,
  schema: Schema,
): Promise<Schema extends typeof BenchmarkBudgetsSchema ? BenchmarkBudgets : BenchmarkResult> {
  const text = await readFile(path, "utf8");
  return parseJson(schema, text) as Schema extends typeof BenchmarkBudgetsSchema
    ? BenchmarkBudgets
    : BenchmarkResult;
}

async function main(args: readonly string[]): Promise<number> {
  try {
    const options = parseArgs(args);
    const [budgets, result, baseline] = await Promise.all([
      loadJson(options.budgets, BenchmarkBudgetsSchema),
      loadJson(options.result, BenchmarkResultSchema),
      options.baseline === undefined
        ? Promise.resolve(undefined)
        : loadJson(options.baseline, BenchmarkResultSchema),
    ]);
    const violations = compareBenchmarkResults(
      budgets,
      result,
      baseline,
      options.allowMissingBaseline,
    );
    process.stdout.write(`${formatComparison(budgets, result, baseline, violations)}\n`);
    if (violations.length > 0) {
      process.stderr.write(`Performance budgets failed (${String(violations.length)} violation(s)).\n`);
      return 1;
    }
    if (baseline === undefined && budgets.relative.length > 0) {
      process.stdout.write("No previous result; relative budgets were not evaluated.\n");
    }
    return 0;
  } catch {
    process.stderr.write("Unable to validate performance budget inputs.\n");
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  });
}
