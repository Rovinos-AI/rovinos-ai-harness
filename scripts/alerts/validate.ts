// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { METRIC_ALLOWLIST } from "@rovinos/telemetry";
import { parseJson, parseYaml } from "@rovinos/schemas";
import { collectHeadingIds } from "../docs/markdown-anchors.ts";
import {
  AlertThresholdsSchema,
  DatadogMonitorsSchema,
  type AlertId,
  type DatadogMonitor,
} from "./contracts.ts";
import { createDatadogMonitors } from "./template.ts";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const metricQueryPattern =
  /(?:^|[^\w.-])(?:avg|sum|count|min|max|p50|p75|p90|p95|p99):(\w[\w.-]*)/gu;
const highCardinalityNamePattern = /(?:^|\.)(?:id|run|session|user|trace|span|path|url)(?:$|\.)/iu;

/** Closed set of alert validation error codes. */
export type AlertValidationErrorCode =
  | "alert_metric_missing"
  | "alert_metric_not_allowlisted"
  | "alert_high_cardinality_label"
  | "alert_threshold_mismatch"
  | "alert_runbook_missing"
  | "alert_runbook_anchor_missing"
  | "alert_runbook_placeholder"
  | "alert_monitor_set_invalid"
  | "alert_sentinel_must_page";

/** Error raised when alert configuration violates the checked repository subset. */
export class AlertValidationError extends Error {
  /** Stable alert validation failure code. */
  readonly code: AlertValidationErrorCode;

  /** Creates an alert validation error. */
  constructor(code: AlertValidationErrorCode) {
    super(code);
    this.name = "AlertValidationError";
    this.code = code;
  }
}

function fail(code: AlertValidationErrorCode): never {
  throw new AlertValidationError(code);
}

function metricNames(query: string): string[] {
  return [...query.matchAll(metricQueryPattern)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

function hasHighCardinalityLabels(monitor: DatadogMonitor): boolean {
  const groupedLabels = [...monitor.query.matchAll(/\bby\s+\{([^}]*)\}/giu)].flatMap((match) =>
    (match[1] ?? "").split(",").map((label) => label.trim()),
  );
  return [...monitor.tags, ...groupedLabels].some((label) => {
    const tagName = label.split(":", 1)[0] ?? label;
    return highCardinalityNamePattern.test(tagName);
  });
}

function validateMonitorMetrics(
  monitor: DatadogMonitor,
  allowedMetrics: ReadonlySet<string>,
): void {
  if (hasHighCardinalityLabels(monitor)) {
    fail("alert_high_cardinality_label");
  }

  const metrics = metricNames(monitor.query);
  if (monitor.type === "metric alert" && metrics.length === 0) {
    fail("alert_metric_missing");
  }
  if (metrics.some((metric) => !allowedMetrics.has(metric))) {
    fail("alert_metric_not_allowlisted");
  }
}

function validateMonitorRunbook(
  monitor: DatadogMonitor,
  runbooks: Readonly<Record<string, string>>,
): void {
  const [runbookPath, anchor] = monitor.runbook.split("#");
  if (runbookPath === undefined || anchor === undefined) {
    fail("alert_runbook_missing");
  }
  const runbook = runbooks[runbookPath];
  if (runbook === undefined) {
    fail("alert_runbook_missing");
  }
  if (!collectHeadingIds(runbook).has(anchor)) {
    fail("alert_runbook_anchor_missing");
  }
}

function validateMonitorThreshold(
  monitor: DatadogMonitor,
  expectedMonitors: ReadonlyMap<AlertId, DatadogMonitor>,
): void {
  const expected = expectedMonitors.get(monitor.id);
  if (
    expected === undefined ||
    monitor.threshold_key !== monitor.id ||
    !isDeepStrictEqual(monitor, expected)
  ) {
    fail("alert_threshold_mismatch");
  }
}

function validateMonitorSet(
  monitors: readonly DatadogMonitor[],
  expectedMonitors: ReadonlyMap<AlertId, DatadogMonitor>,
): void {
  const monitorIds = new Set(monitors.map(({ id }) => id));
  if (
    monitorIds.size !== monitors.length ||
    monitorIds.size !== expectedMonitors.size ||
    [...expectedMonitors.keys()].some((id) => !monitorIds.has(id))
  ) {
    fail("alert_monitor_set_invalid");
  }
}

function validateSentinel(
  monitors: readonly DatadogMonitor[],
  thresholds: ReturnType<typeof AlertThresholdsSchema.parse>,
): void {
  const sentinel = monitors.find(({ id }) => id === "leak_sentinel");
  if (
    sentinel === undefined ||
    thresholds.leak_sentinel.critical !== 0 ||
    sentinel.priority !== 1 ||
    !sentinel.query.endsWith("> 0")
  ) {
    fail("alert_sentinel_must_page");
  }
}

/** Validates the monitor, threshold, metric, and runbook contracts without exposing file contents. */
export function validateAlerts(
  thresholdsText: string,
  monitorsText: string,
  runbooks: Readonly<Record<string, string>>,
  metricAllowlist: Readonly<Record<string, readonly string[]>> = METRIC_ALLOWLIST,
): void {
  const thresholds = parseYaml(AlertThresholdsSchema, thresholdsText);
  const monitors = parseJson(DatadogMonitorsSchema, monitorsText);
  if (Object.values(runbooks).some((runbook) => /TODO/iu.test(runbook))) {
    fail("alert_runbook_placeholder");
  }
  const expectedMonitors = new Map<AlertId, DatadogMonitor>(
    createDatadogMonitors(thresholds).map((monitor) => [monitor.id, monitor]),
  );
  validateMonitorSet(monitors, expectedMonitors);
  const allowedMetrics = new Set(Object.keys(metricAllowlist));
  for (const monitor of monitors) {
    validateMonitorMetrics(monitor, allowedMetrics);
    validateMonitorRunbook(monitor, runbooks);
    validateMonitorThreshold(monitor, expectedMonitors);
  }
  validateSentinel(monitors, thresholds);
}

function loadRunbooks(): Readonly<Record<string, string>> {
  const runbookDirectory = resolve(rootDirectory, "docs/runbooks");
  return Object.fromEntries(
    readdirSync(runbookDirectory)
      .filter((filename) => filename.endsWith(".md"))
      .map((filename) => [
        `docs/runbooks/${filename}`,
        readFileSync(resolve(runbookDirectory, filename), "utf8"),
      ]),
  );
}

function main(): void {
  try {
    validateAlerts(
      readFileSync(resolve(rootDirectory, "infra/alerts/thresholds.yaml"), "utf8"),
      readFileSync(resolve(rootDirectory, "infra/alerts/datadog-monitors.json"), "utf8"),
      loadRunbooks(),
    );
    process.stdout.write("Alert definitions are valid.\n");
  } catch {
    process.stderr.write("Alert configuration validation failed.\n");
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  main();
}
