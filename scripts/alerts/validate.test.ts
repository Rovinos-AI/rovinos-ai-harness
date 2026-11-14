// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { METRIC_ALLOWLIST } from "@rovinos/telemetry";
import { describe, expect, it } from "vitest";
import { AlertValidationError, validateAlerts } from "./validate.ts";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const thresholdsText = readFileSync(resolve(rootDirectory, "infra/alerts/thresholds.yaml"), "utf8");
const monitorsText = readFileSync(
  resolve(rootDirectory, "infra/alerts/datadog-monitors.json"),
  "utf8",
);

function readRunbooks(): Record<string, string> {
  const directory = resolve(rootDirectory, "docs/runbooks");
  return Object.fromEntries(
    readdirSync(directory)
      .filter((filename) => filename.endsWith(".md"))
      .map((filename) => [
        `docs/runbooks/${filename}`,
        readFileSync(resolve(directory, filename), "utf8"),
      ]),
  );
}

describe("alert configuration validator", () => {
  it("accepts committed thresholds, monitors, metrics, and runbook anchors", () => {
    expect(() => {
      validateAlerts(thresholdsText, monitorsText, readRunbooks());
    }).not.toThrow();
  });

  it("rejects monitor metrics outside METRIC_ALLOWLIST", () => {
    const invalid = monitorsText.replace(
      "harness.pii.detector_degraded",
      "harness.unknown.metric",
    );

    expect(() => {
      validateAlerts(thresholdsText, invalid, readRunbooks());
    }).toThrow(new AlertValidationError("alert_metric_not_allowlisted"));
  });

  it("rejects high-cardinality metric labels", () => {
    const invalid = monitorsText.replace(
      "harness.telemetry.dropped{harness.telemetry.dropped.reason:leak_sentinel}",
      "harness.telemetry.dropped{harness.telemetry.dropped.reason:leak_sentinel} by {harness.run.id}",
    );

    expect(() => {
      validateAlerts(thresholdsText, invalid, readRunbooks());
    }).toThrow(new AlertValidationError("alert_high_cardinality_label"));
  });

  it("rejects runbook references without a matching heading anchor", () => {
    const invalid = monitorsText.replace(
      '"runbook": "docs/runbooks/leak-sentinel.md#suspected-telemetry-leak"',
      '"runbook": "docs/runbooks/leak-sentinel.md#missing-anchor"',
    );

    expect(() => {
      validateAlerts(thresholdsText, invalid, readRunbooks());
    }).toThrow(new AlertValidationError("alert_runbook_anchor_missing"));
  });

  it("rejects missing runbooks and TODO placeholders", () => {
    const runbooks = readRunbooks();
    const missing = { ...runbooks };
    delete missing["docs/runbooks/leak-sentinel.md"];
    expect(() => {
      validateAlerts(thresholdsText, monitorsText, missing);
    }).toThrow(new AlertValidationError("alert_runbook_missing"));

    const withPlaceholder = {
      ...runbooks,
      "docs/runbooks/leak-sentinel.md": `${runbooks["docs/runbooks/leak-sentinel.md"] ?? ""}\nTODO`,
    };
    expect(() => {
      validateAlerts(thresholdsText, monitorsText, withPlaceholder);
    }).toThrow(new AlertValidationError("alert_runbook_placeholder"));
  });

  it("requires each threshold and its generated monitor to stay in sync", () => {
    const excludedMetricAllowlist = Object.fromEntries(
      Object.entries(METRIC_ALLOWLIST).filter(([name]) => name !== "harness.pii.detector_degraded"),
    );
    expect(() => {
      validateAlerts(thresholdsText, monitorsText, readRunbooks(), excludedMetricAllowlist);
    }).toThrow(new AlertValidationError("alert_metric_not_allowlisted"));

    const missingThreshold = thresholdsText.replace(
      "pii_detector_degraded:\n  window_minutes: 5\n  critical: 0\n  priority: 2\n",
      "",
    );
    expect(() => {
      validateAlerts(missingThreshold, monitorsText, readRunbooks());
    }).toThrow();
  });
});
