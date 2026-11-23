// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { createReportsView } from "./view.js";

const evalReport = {
  kind: "eval",
  report: {
    schemaVersion: 1,
    invariantsEnabled: true,
    trials: [
      {
        taskId: "task.one",
        variantId: "variant.a",
        passed: false,
        graders: [{ graderId: "grader.output", pass: false, codes: ["schema_invalid"] }],
      },
    ],
    aggregates: [
      {
        taskId: "task.one",
        variantId: "variant.a",
        n: 2,
        passes: 1,
        passRate: 0.5,
        standardError: 0.1,
        passAtK: [{ k: 1, rate: 0.5 }],
        costMicros: { mean: 10, median: 10, p95: 10 },
        steps: { mean: 3, median: 3, p95: 3 },
        latencyMs: { mean: 50, median: 50, p95: 50 },
      },
    ],
  },
} as const;

const comparisonReport = {
  kind: "compare",
  report: {
    schemaVersion: 1,
    comparisons: [
      {
        scope: "overall",
        variantA: "variant.a",
        variantB: "variant.b",
        metrics: [
          {
            metric: "pass_rate",
            a: 0.5,
            b: 0.75,
            verdict: "better",
            adjustedPValue: 0.04,
            confidenceInterval: { low: 0.1, high: 0.4 },
          },
        ],
      },
    ],
  },
} as const;

const replayReport = {
  kind: "replay",
  report: {
    schemaVersion: 1,
    summary: { added: 1, behavioral: 1, changed: 1, noise: 1, removed: 0 },
    entries: [
      {
        class: "behavioral",
        eventKind: "tool_call",
        index: 0,
        kind: "changed",
        fields: [{ field: "outcome", a: "ok", b: "failed" }],
      },
      {
        class: "noise",
        eventKind: "model_response",
        index: 1,
        kind: "added",
      },
    ],
  },
} as const;

afterEach(() => {
  document.body.replaceChildren();
});

describe("reports view", () => {
  it.each([
    [evalReport, "Evaluation report", "schema_invalid"],
    [comparisonReport, "A/B comparison report", "Adjusted p-value"],
    [replayReport, "Replay report", "Behavioral differences"],
  ] as const)("renders %s data", (report, title, content) => {
    createReportsView(document.body).receiveResult(report);
    expect(document.querySelector("h1")?.textContent).toBe(title);
    expect(document.body.textContent).toContain(content);
  });

  it("keeps the pass-rate chart and accessible table data in parity", () => {
    createReportsView(document.body).receiveResult(evalReport);
    const bar = document.querySelector("svg rect");
    const passRateCell = document.querySelector("tbody td:nth-child(3)");
    expect(bar?.getAttribute("width")).toBe("160");
    expect(passRateCell?.textContent).toBe("0.5");
    expect(document.querySelector("table caption")?.textContent).toContain(
      "confidence intervals",
    );
  });

  it("renders untrusted strings as text and rejects invalid report codes", () => {
    createReportsView(document.body).receiveInput({
      kind: "eval",
      path: '<img src=x onerror="alert(1)">',
    });
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).not.toContain("<img");

    createReportsView(document.body).receiveResult({
      ...evalReport,
      report: {
        ...evalReport.report,
        trials: [
          {
            ...evalReport.report.trials[0],
            graders: [{ graderId: '<img src=x onerror="alert(1)">', pass: false, codes: [] }],
          },
        ],
      },
    });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Report could not be opened.",
    );
  });

  it.each([evalReport, comparisonReport, replayReport])("passes axe checks for $kind", async (report) => {
    createReportsView(document.body).receiveResult(report);
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
