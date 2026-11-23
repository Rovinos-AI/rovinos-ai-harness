// SPDX-License-Identifier: Apache-2.0
import { createDataTable } from "../../kit/components.js";
import { formatMessage, getStrings, type UiStrings } from "../../kit/strings.js";
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
  strings: UiStrings,
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
      confidenceInterval: formatMessage(strings.reportsConfidenceRange, {
        low: numberText(Math.max(0, aggregate.passRate - margin)),
        high: numberText(Math.min(1, aggregate.passRate + margin)),
      }),
      passAtK: aggregate.passAtK
        .map(({ k, rate }) =>
          formatMessage(strings.reportsPassAtKValue, { k, rate: numberText(rate) }),
        )
        .join(strings.reportsListSeparator),
    };
  });
  const section = element(document, "section");
  section.append(element(document, "h2", strings.reportsPassRates));
  section.append(createPassChart(document, chartRows));
  section.append(
    createDataTable(
      document,
      strings.reportsPassRatesTable,
      [
        { key: "task", label: strings.reportsTask },
        { key: "variant", label: strings.reportsVariant },
        { key: "passRate", label: strings.reportsPassRate },
        { key: "confidenceInterval", label: strings.reportsConfidenceInterval },
        { key: "passAtK", label: strings.reportsPassAtK },
      ],
      passRows,
    ),
  );
  return section;
}

function evalDistributionRows(
  report: Extract<ReportsViewResult, { kind: "eval" }>,
  strings: UiStrings,
) {
  return report.report.aggregates.flatMap((aggregate) =>
    [
      { metric: strings.reportsCostMicros, summary: aggregate.costMicros },
      { metric: strings.reportsSteps, summary: aggregate.steps },
      { metric: strings.reportsLatencyMs, summary: aggregate.latencyMs },
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

function evalFailureRows(report: Extract<ReportsViewResult, { kind: "eval" }>, strings: UiStrings) {
  const failures = report.report.trials.flatMap((trial) =>
    trial.graders
      .filter(({ pass }) => !pass)
      .map((grader) => ({
        task: trial.taskId,
        variant: trial.variantId,
        grader: grader.graderId,
        codes: grader.codes.join(strings.reportsListSeparator),
      })),
  );
  return failures.length > 0
    ? failures
    : [
        {
          task: strings.reportsNotAvailable,
          variant: strings.reportsNotAvailable,
          grader: strings.reportsNotAvailable,
          codes: strings.reportsNoFailures,
        },
      ];
}

function renderEval(
  document: Document,
  report: Extract<ReportsViewResult, { kind: "eval" }>,
  strings: UiStrings,
): HTMLElement[] {
  return [
    evalPassSection(document, report, strings),
    reportSection(
      document,
      strings.reportsDistributions,
      [
        { key: "task", label: strings.reportsTask },
        { key: "variant", label: strings.reportsVariant },
        { key: "metric", label: strings.reportsMetric },
        { key: "mean", label: strings.reportsMean },
        { key: "median", label: strings.reportsMedian },
        { key: "p95", label: strings.reportsP95 },
      ],
      evalDistributionRows(report, strings),
    ),
    reportSection(
      document,
      `${strings.reportsFailures}${report.report.invariantsEnabled ? "" : strings.reportsInvariantsDisabled}`,
      [
        { key: "task", label: strings.reportsTask },
        { key: "variant", label: strings.reportsVariant },
        { key: "grader", label: strings.reportsGrader },
        { key: "codes", label: strings.reportsCodes },
      ],
      evalFailureRows(report, strings),
    ),
  ];
}

function renderComparison(
  document: Document,
  report: Extract<ReportsViewResult, { kind: "compare" }>,
  strings: UiStrings,
): HTMLElement[] {
  const rows = report.report.comparisons.flatMap((comparison) =>
    comparison.metrics.map((metric) => ({
      scope:
        comparison.scope === "task"
          ? formatMessage(strings.reportsTaskScope, { task: comparison.taskId ?? "" })
          : strings.reportsOverall,
      variants: formatMessage(strings.reportsComparedVariants, {
        a: comparison.variantA,
        b: comparison.variantB,
      }),
      metric: metric.metric,
      a: numberText(metric.a),
      b: numberText(metric.b),
      verdict: metric.verdict,
      adjustedPValue:
        metric.adjustedPValue === null
          ? strings.reportsNotAvailable
          : numberText(metric.adjustedPValue),
      confidenceInterval:
        metric.confidenceInterval === null
          ? strings.reportsNotAvailable
          : formatMessage(strings.reportsConfidenceRange, {
              low: numberText(metric.confidenceInterval.low),
              high: numberText(metric.confidenceInterval.high),
            }),
    })),
  );
  return [
    reportSection(
      document,
      strings.reportsComparisons,
      [
        { key: "scope", label: strings.reportsScope },
        { key: "variants", label: strings.reportsVariants },
        { key: "metric", label: strings.reportsMetric },
        { key: "a", label: strings.reportsA },
        { key: "b", label: strings.reportsB },
        { key: "verdict", label: strings.reportsVerdict },
        { key: "adjustedPValue", label: strings.reportsAdjustedPValue },
        { key: "confidenceInterval", label: strings.reportsConfidenceInterval },
      ],
      rows,
    ),
  ];
}

function renderReplay(
  document: Document,
  report: Extract<ReportsViewResult, { kind: "replay" }>,
  strings: UiStrings,
): HTMLElement[] {
  const replayRows = (entryClass: "behavioral" | "noise") =>
    report.report.entries
      .filter(({ class: classification }) => classification === entryClass)
      .map((entry) => ({
        index: String(entry.index),
        event: entry.eventKind,
        change: entry.kind,
        fields:
          entry.fields === undefined
            ? strings.reportsNotAvailable
            : entry.fields
                .map(({ field, a, b }) =>
                  formatMessage(strings.reportsFieldValue, {
                    field,
                    a: String(a),
                    b: String(b),
                  }),
                )
                .join(strings.reportsFieldSeparator),
      }));
  const summary = report.report.summary;
  return [
    reportSection(
      document,
      strings.reportsReplaySummary,
      [
        { key: "behavioral", label: strings.reportsBehavioral },
        { key: "noise", label: strings.reportsNoise },
        { key: "added", label: strings.reportsAdded },
        { key: "removed", label: strings.reportsRemoved },
        { key: "changed", label: strings.reportsChanged },
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
      strings.reportsBehavioralDifferences,
      [
        { key: "index", label: strings.reportsIndex },
        { key: "event", label: strings.reportsEvent },
        { key: "change", label: strings.reportsChange },
        { key: "fields", label: strings.reportsFields },
      ],
      replayRows("behavioral"),
    ),
    reportSection(
      document,
      strings.reportsNoiseDifferences,
      [
        { key: "index", label: strings.reportsIndex },
        { key: "event", label: strings.reportsEvent },
        { key: "change", label: strings.reportsChange },
        { key: "fields", label: strings.reportsFields },
      ],
      replayRows("noise"),
    ),
  ];
}

/** Renders a validated report with text-only DOM APIs and semantic table alternatives. */
export function renderReport(
  container: HTMLElement,
  value: ReportsViewResult,
  strings = getStrings(container.ownerDocument.documentElement.lang),
): void {
  const document = container.ownerDocument;
  const main = element(document, "main");
  switch (value.kind) {
    case "eval":
      main.append(
        element(document, "h1", strings.reportsEvalTitle),
        ...renderEval(document, value, strings),
      );
      break;
    case "compare":
      main.append(
        element(document, "h1", strings.reportsCompareTitle),
        ...renderComparison(document, value, strings),
      );
      break;
    case "replay":
      main.append(
        element(document, "h1", strings.reportsReplayTitle),
        ...renderReplay(document, value, strings),
      );
      break;
  }
  container.replaceChildren(main);
}
