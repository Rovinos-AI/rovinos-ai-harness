// SPDX-License-Identifier: Apache-2.0
import { EvalReportSchema } from "./schema.js";
import type { EvalTrialMetrics, MetricSummary } from "./schema.js";

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareTrials(left: EvalTrialMetrics, right: EvalTrialMetrics): number {
  const taskOrder = compareText(left.taskId, right.taskId);
  if (taskOrder !== 0) {
    return taskOrder;
  }
  const variantOrder = compareText(left.variantId, right.variantId);
  return variantOrder !== 0 ? variantOrder : left.trialIndex - right.trialIndex;
}

function formatNumber(value: number): string {
  return value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatSummary(summary: MetricSummary): string {
  return [summary.mean, summary.median, summary.p95].map(formatNumber).join(" / ");
}

function failureCodes(trial: EvalTrialMetrics): string[] {
  return [
    ...new Set(trial.graders.filter(({ pass }) => !pass).flatMap(({ codes }) => codes)),
  ].sort();
}

/** Renders a content-free Markdown table per variant and failures by code only. */
export function renderMarkdownReport(report: unknown): string {
  const parsed = EvalReportSchema.parse(report);
  const variants = [...new Set(parsed.aggregates.map(({ variantId }) => variantId))].sort(
    compareText,
  );
  const lines = [
    "# Evaluation report",
    "",
    `Approval integrity checks: ${parsed.invariantsEnabled ? "enabled" : "disabled"}`,
    "",
  ];
  for (const variantId of variants) {
    lines.push(
      `## Variant \`${variantId}\``,
      "",
      "| Task | Trials | Passes | Pass rate | pass@k | Cost mean / median / p95 (µUSD) | Tokens mean / median / p95 | Steps mean / median / p95 | Latency mean / median / p95 (ms) |",
      "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |",
    );
    for (const aggregate of parsed.aggregates.filter((item) => item.variantId === variantId)) {
      lines.push(
        `| ${aggregate.taskId} | ${String(aggregate.n)} | ${String(aggregate.passes)} | ${(aggregate.passRate * 100).toFixed(1)}% | ${aggregate.passAtK.map(({ k, rate }) => `${String(k)}: ${(rate * 100).toFixed(1)}%`).join(", ")} | ${formatSummary(aggregate.costMicros)} | ${formatSummary(aggregate.totalTokens)} | ${formatSummary(aggregate.steps)} | ${formatSummary(aggregate.latencyMs)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Failures", "");
  const failures = parsed.trials.filter(({ passed }) => !passed).sort(compareTrials);
  if (failures.length === 0) {
    lines.push("No failures.");
  } else {
    for (const trial of failures) {
      lines.push(
        `- \`${trial.taskId}\` / \`${trial.variantId}\` trial ${String(trial.trialIndex)}: ${failureCodes(
          trial,
        )
          .map((code) => `\`${code}\``)
          .join(", ")}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
