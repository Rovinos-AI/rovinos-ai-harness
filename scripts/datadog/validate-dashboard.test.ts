// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DashboardValidationError, validateDatadogDashboard } from "./validate-dashboard.ts";

const dashboardText = readFileSync(
  new URL("../../infra/dashboards/datadog/harness-overview.json", import.meta.url),
  "utf8",
);

describe("Datadog dashboard validator", () => {
  it("accepts the committed dashboard and its allowlisted queries", () => {
    const dashboard = validateDatadogDashboard(dashboardText);

    expect(dashboard.widgets.map(({ definition }) => definition.title)).toEqual([
      "Runs",
      "Models",
      "Safety",
      "Approvals",
      "Tools",
    ]);
  });

  it("rejects a query for a metric outside METRIC_ALLOWLIST", () => {
    const invalid = dashboardText.replace("harness.run.completed", "harness.unknown.metric");

    expect(() => validateDatadogDashboard(invalid)).toThrow(
      new DashboardValidationError("dashboard_metric_not_allowlisted"),
    );
  });

  it("rejects unsupported widget types", () => {
    const invalid = dashboardText.replace('"type": "timeseries"', '"type": "heatmap"');

    expect(() => validateDatadogDashboard(invalid)).toThrow();
  });

  it("rejects duplicate group titles", () => {
    const invalid = dashboardText.replace('"title": "Tools"', '"title": "Runs"');

    expect(() => validateDatadogDashboard(invalid)).toThrow(
      new DashboardValidationError("dashboard_group_title_duplicate"),
    );
  });

  it("rejects queries without a recognizable metric expression", () => {
    const invalid = dashboardText.replace(
      "sum:harness.run.completed{*}",
      "harness.run.completed{*}",
    );

    expect(() => validateDatadogDashboard(invalid)).toThrow(
      new DashboardValidationError("dashboard_query_metric_missing"),
    );
  });
});
