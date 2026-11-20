// SPDX-License-Identifier: Apache-2.0
import { createDataTable } from "../../kit/components.js";
import type { ReportsViewResult } from "./schema.js";

const svgNamespace = ["http:", "", "www.w3.org", "2000", "svg"].join("/");

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function numberText(value: number): string {
  return value.toLocaleString("en", { maximumFractionDigits: 3 });
}

function reportSection(
  document: Document,
  title: string,
  columns: readonly { readonly key: string; readonly label: string }[],
  rows: readonly Readonly<Record<string, string>>[],
): HTMLElement {
  const section = element(document, "section");
  section.append(element(document, "h2", title));
  section.append(createDataTable(document, title, columns, rows));
  return section;
}

function createPassChart(
  document: Document,
  rows: readonly { readonly label: string; readonly rate: number }[],
): Element {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", `0 0 320 ${String(Math.max(24, rows.length * 24))}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("aria-hidden", "true");
  rows.forEach(({ rate }, index) => {
    const bar = document.createElementNS(svgNamespace, "rect");
    bar.setAttribute("x", "0");
    bar.setAttribute("y", String(index * 24));
    bar.setAttribute("width", String(Math.max(0, rate * 320)));
    bar.setAttribute("height", "16");
    bar.setAttribute("fill", "currentColor");
    svg.append(bar);
  });
  return svg;
}

function evalPassSection(
  document: Document,
  report: Extract<ReportsViewResult, { kind: "eval" }>,
): HTMLElement {
  const chartRows = report.report.aggregates.map((aggregate) => ({
    label: `${aggregate.taskId} / ${aggregate.variantId}`,
    rate: aggregate.passRate,
  }));
  const passRows = report.report.aggregates.map((aggregate) => {
    const margin = 1.96 * aggregate.standardError;
    return {
      task: aggregate.taskId,
      variant: aggregate.variantId,
      passRate: numberText(aggregate.passRate),
      confidenceInterval: `${numberText(Math.max(0, aggregate.passRate - margin))}–${numberText(Math.min(1, aggregate.passRate + margin))}`,
      passAtK: aggregate.passAtK.map(({ k, rate }) => `${String(k)}=${numberText(rate)}`).join(", "),
    };
  });
  const section = element(document, "section");
  section.append(element(document, "h2", "Pass rates"));
  section.append(createPassChart(document, chartRows));
  section.append(
    createDataTable(
      document,
      "Pass rates with 95% confidence intervals and pass@k",
      [
        { key: "task", label: "Task" },
        { key: "variant", label: "Variant" },
        { key: "passRate", label: "Pass rate" },
        { key: "confidenceInterval", label: "95% confidence interval" },
        { key: "passAtK", label: "Pass@k" },
      ],
      passRows,
    ),
  );
  return section;
}

function evalDistributionRows(report: Extract<ReportsViewResult, { kind: "eval" }>) {
  return report.report.aggregates.flatMap((aggregate) =>
    [
      { metric: "cost (micros)", summary: aggregate.costMicros },
      { metric: "steps", summary: aggregate.steps },
      { metric: "latency (ms)", summary: aggregate.latencyMs },
    ].map(({ metric, summary }) => ({
      task: aggregate.taskId,
      variant: aggregate.variantId,
      metric,
      mean: numberText(summary.mean),
      median: numberText(summary.median),
      p95: numberText(summary.p95),
    })),
  );
}

function evalFailureRows(report: Extract<ReportsViewResult, { kind: "eval" }>) {
  const failures = report.report.trials.flatMap((trial) =>
    trial.graders
      .filter(({ pass }) => !pass)
      .map((grader) => ({
        task: trial.taskId,
        variant: trial.variantId,
        grader: grader.graderId,
        codes: grader.codes.join(", "),
      })),
  );
  return failures.length > 0
    ? failures
    : [{ task: "—", variant: "—", grader: "—", codes: "No failures" }];
}

function renderEval(
  document: Document,
  report: Extract<ReportsViewResult, { kind: "eval" }>,
): HTMLElement[] {
  return [
    evalPassSection(document, report),
    reportSection(
      document,
      "Cost, steps, and latency distributions",
      [
        { key: "task", label: "Task" },
        { key: "variant", label: "Variant" },
        { key: "metric", label: "Metric" },
        { key: "mean", label: "Mean" },
        { key: "median", label: "Median" },
        { key: "p95", label: "P95" },
      ],
      evalDistributionRows(report),
    ),
    reportSection(
      document,
      `Failing grader and invariant codes${report.report.invariantsEnabled ? "" : " (invariants disabled)"}`,
      [
        { key: "task", label: "Task" },
        { key: "variant", label: "Variant" },
        { key: "grader", label: "Grader" },
        { key: "codes", label: "Codes" },
      ],
      evalFailureRows(report),
    ),
  ];
}

function renderComparison(
  document: Document,
  report: Extract<ReportsViewResult, { kind: "compare" }>,
): HTMLElement[] {
  const rows = report.report.comparisons.flatMap((comparison) =>
    comparison.metrics.map((metric) => ({
      scope:
        comparison.scope === "task" ? `Task: ${comparison.taskId ?? ""}` : "Overall",
      variants: `${comparison.variantA} vs ${comparison.variantB}`,
      metric: metric.metric,
      a: numberText(metric.a),
      b: numberText(metric.b),
      verdict: metric.verdict,
      adjustedPValue:
        metric.adjustedPValue === null ? "—" : numberText(metric.adjustedPValue),
      confidenceInterval:
        metric.confidenceInterval === null
          ? "—"
          : `${numberText(metric.confidenceInterval.low)}–${numberText(metric.confidenceInterval.high)}`,
    })),
  );
  return [
    reportSection(
      document,
      "A/B comparisons",
      [
        { key: "scope", label: "Scope" },
        { key: "variants", label: "Variants" },
        { key: "metric", label: "Metric" },
        { key: "a", label: "A" },
        { key: "b", label: "B" },
        { key: "verdict", label: "Verdict" },
        { key: "adjustedPValue", label: "Adjusted p-value" },
        { key: "confidenceInterval", label: "Confidence interval" },
      ],
      rows,
    ),
  ];
}

function renderReplay(
  document: Document,
  report: Extract<ReportsViewResult, { kind: "replay" }>,
): HTMLElement[] {
  const replayRows = (entryClass: "behavioral" | "noise") =>
    report.report.entries
      .filter(({ class: classification }) => classification === entryClass)
      .map((entry) => ({
        index: String(entry.index),
        event: entry.eventKind,
        change: entry.kind,
        fields:
          entry.fields
            ?.map(({ field, a, b }) => `${field}: ${String(a)} → ${String(b)}`)
            .join("; ") ?? "—",
      }));
  const summary = report.report.summary;
  return [
    reportSection(
      document,
      "Replay diff summary",
      [
        { key: "behavioral", label: "Behavioral" },
        { key: "noise", label: "Noise" },
        { key: "added", label: "Added" },
        { key: "removed", label: "Removed" },
        { key: "changed", label: "Changed" },
      ],
      [
        {
          behavioral: String(summary.behavioral),
          noise: String(summary.noise),
          added: String(summary.added),
          removed: String(summary.removed),
          changed: String(summary.changed),
        },
      ],
    ),
    reportSection(
      document,
      "Behavioral differences",
      [
        { key: "index", label: "Index" },
        { key: "event", label: "Event" },
        { key: "change", label: "Change" },
        { key: "fields", label: "Fields (original → replay)" },
      ],
      replayRows("behavioral"),
    ),
    reportSection(
      document,
      "Noise differences",
      [
        { key: "index", label: "Index" },
        { key: "event", label: "Event" },
        { key: "change", label: "Change" },
        { key: "fields", label: "Fields (original → replay)" },
      ],
      replayRows("noise"),
    ),
  ];
}

/** Renders a validated report with text-only DOM APIs and semantic table alternatives. */
export function renderReport(container: HTMLElement, value: ReportsViewResult): void {
  const document = container.ownerDocument;
  const main = element(document, "main");
  switch (value.kind) {
    case "eval":
      main.append(element(document, "h1", "Evaluation report"), ...renderEval(document, value));
      break;
    case "compare":
      main.append(
        element(document, "h1", "A/B comparison report"),
        ...renderComparison(document, value),
      );
      break;
    case "replay":
      main.append(element(document, "h1", "Replay report"), ...renderReplay(document, value));
      break;
  }
  container.replaceChildren(main);
}
