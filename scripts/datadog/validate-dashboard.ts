// SPDX-License-Identifier: Apache-2.0
import { METRIC_ALLOWLIST } from "@rovinos/telemetry";
import { parseJson } from "@rovinos/schemas";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const QueryRequestSchema = z
  .object({
    q: z.string().min(1),
    display_type: z.enum(["line", "area", "bars"]).optional(),
  })
  .strict();

const TimeseriesWidgetSchema = z
  .object({
    type: z.literal("timeseries"),
    title: z.string().min(1),
    requests: z.array(QueryRequestSchema).min(1),
  })
  .strict();

const QueryValueWidgetSchema = z
  .object({
    type: z.literal("query_value"),
    title: z.string().min(1),
    requests: z.array(z.object({ q: z.string().min(1) }).strict()).min(1),
    autoscale: z.boolean().optional(),
    precision: z.number().int().nonnegative().optional(),
    conditional_formats: z
      .array(
        z
          .object({
            comparator: z.enum([">", ">=", "<", "<=", "=", "!="]),
            value: z.number(),
            palette: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const LeafWidgetSchema = z.discriminatedUnion("type", [
  TimeseriesWidgetSchema,
  QueryValueWidgetSchema,
]);

const WidgetSchema = z.object({ definition: LeafWidgetSchema }).strict();
const GroupWidgetSchema = z
  .object({
    definition: z
      .object({
        type: z.literal("group"),
        title: z.string().min(1),
        layout_type: z.literal("ordered"),
        widgets: z.array(WidgetSchema).min(1),
      })
      .strict(),
  })
  .strict();

const DatadogDashboardSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    layout_type: z.literal("ordered"),
    widgets: z.array(GroupWidgetSchema).min(1),
  })
  .strict();

type DatadogDashboard = z.infer<typeof DatadogDashboardSchema>;

const METRIC_QUERY_PATTERN =
  /(?:^|[^\w.-])(?:avg|sum|count|min|max|p50|p75|p90|p95|p99):(\w[\w.-]*)/gu;

/** Error raised when a dashboard violates the checked Datadog subset. */
export class DashboardValidationError extends Error {
  /** Stable dashboard validation failure code. */
  readonly code:
    | "dashboard_group_title_duplicate"
    | "dashboard_metric_not_allowlisted"
    | "dashboard_query_metric_missing";

  /** Creates a dashboard validation error. */
  constructor(
    code:
      | "dashboard_group_title_duplicate"
      | "dashboard_metric_not_allowlisted"
      | "dashboard_query_metric_missing",
  ) {
    super(code);
    this.name = "DashboardValidationError";
    this.code = code;
  }
}

function dashboardQueries(dashboard: DatadogDashboard): string[] {
  return dashboard.widgets.flatMap(({ definition: group }) =>
    group.widgets.flatMap(({ definition: widget }) => widget.requests.map(({ q }) => q)),
  );
}

/** Parses the repository's Datadog dashboard subset and verifies its groups and metric names. */
export function validateDatadogDashboard(
  text: string,
  metricAllowlist: Readonly<Record<string, readonly string[]>> = METRIC_ALLOWLIST,
): DatadogDashboard {
  const dashboard = parseJson(DatadogDashboardSchema, text);
  const groupTitles = dashboard.widgets.map(({ definition }) => definition.title);
  if (new Set(groupTitles).size !== groupTitles.length) {
    throw new DashboardValidationError("dashboard_group_title_duplicate");
  }

  const allowedMetrics = new Set(Object.keys(metricAllowlist));
  for (const query of dashboardQueries(dashboard)) {
    const metrics = [...query.matchAll(METRIC_QUERY_PATTERN)].map((match) => match[1]);
    if (metrics.length === 0) {
      throw new DashboardValidationError("dashboard_query_metric_missing");
    }
    for (const metric of metrics) {
      if (metric === undefined || !allowedMetrics.has(metric)) {
        throw new DashboardValidationError("dashboard_metric_not_allowlisted");
      }
    }
  }
  return dashboard;
}

function main(): void {
  try {
    const dashboardPath = fileURLToPath(
      new URL("../../infra/dashboards/datadog/harness-overview.json", import.meta.url),
    );
    validateDatadogDashboard(readFileSync(dashboardPath, "utf8"));
    process.stdout.write("Datadog dashboard is valid.\n");
  } catch {
    process.stderr.write("Datadog dashboard validation failed.\n");
    process.exitCode = 1;
  }
}

const scriptPath = process.argv[1];
if (scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href) {
  main();
}
