// SPDX-License-Identifier: Apache-2.0
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalPackage } from "./eval-types.js";
import type { EvalReport } from "@rovinos/eval";

/** Writes metadata-only report formats to the output directory. */
export async function writeReportFiles(
  api: EvalPackage,
  outDir: string,
  report: EvalReport,
): Promise<void> {
  await Promise.all([
    writeFile(join(outDir, "eval-report.json"), api.serializeEvalReport(report), "utf8"),
    writeFile(join(outDir, "eval-report.md"), api.renderMarkdownReport(report), "utf8"),
    writeFile(join(outDir, "junit.xml"), api.renderJunitReport(report), "utf8"),
  ]);
}

/** Prints aggregate report rows to the CLI table output. */
export function writeSummaryTable(
  context: { out: { table(rows: readonly (readonly (string | number | boolean)[])[]): void } },
  report: EvalReport,
): void {
  context.out.table([
    ["Task", "Variant", "Pass rate", "Mean cost (USD)", "Mean steps"],
    ...report.aggregates.map((aggregate) => [
      aggregate.taskId,
      aggregate.variantId,
      `${(aggregate.passRate * 100).toFixed(1)}%`,
      (aggregate.costMicros.mean / 1_000_000).toFixed(6),
      aggregate.steps.mean,
    ]),
  ]);
}
