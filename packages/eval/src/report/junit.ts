// SPDX-License-Identifier: Apache-2.0
import { EvalReportSchema } from "./schema.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Renders a JUnit XML suite with one testcase per task/variant pair. */
export function renderJunitReport(report: unknown): string {
  const parsed = EvalReportSchema.parse(report);
  const failures = parsed.aggregates.filter(({ passes, n }) => passes < n);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="eval" tests="${String(parsed.aggregates.length)}" failures="${String(failures.length)}" errors="0">`,
  ];

  for (const aggregate of parsed.aggregates) {
    const trialGroup = parsed.trials.filter(
      (trial) => trial.taskId === aggregate.taskId && trial.variantId === aggregate.variantId,
    );
    const durationMs = trialGroup.reduce((total, trial) => total + trial.wallTimeMs, 0);
    const name = `${aggregate.taskId}/${aggregate.variantId}`;
    lines.push(
      `  <testcase classname="${escapeXml(aggregate.taskId)}" name="${escapeXml(name)}" time="${(durationMs / 1_000).toFixed(3)}">`,
    );
    if (aggregate.passes < aggregate.n) {
      const codes = [
        ...new Set(
          trialGroup
            .filter(({ passed }) => !passed)
            .flatMap((trial) =>
              trial.graders
                .filter(({ pass }) => !pass)
                .flatMap(({ codes: graderCodes }) => graderCodes),
            ),
        ),
      ].sort();
      lines.push(`    <failure message="${escapeXml(codes.join(", "))}" type="assertion"/>`);
    }
    lines.push("  </testcase>");
  }
  lines.push("</testsuite>");
  return `${lines.join("\n")}\n`;
}
