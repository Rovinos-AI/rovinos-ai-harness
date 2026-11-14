// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AlertThresholdsSchema } from "./contracts.ts";
import { renderDatadogMonitors, runAlertGenerator } from "./generate.ts";
import { parseYaml } from "@rovinos/schemas";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const thresholdsPath = join(rootDirectory, "infra/alerts/thresholds.yaml");

describe("Datadog alert generator", () => {
  it("renders deterministic monitors from validated thresholds", () => {
    const thresholds = parseYaml(AlertThresholdsSchema, readFileSync(thresholdsPath, "utf8"));
    const first = renderDatadogMonitors(thresholds);

    expect(renderDatadogMonitors(thresholds)).toBe(first);
    expect(first).toContain('"query": "sum(last_5m):sum:harness.telemetry.dropped');
    expect(first).toContain('"priority": 1');
  });

  it("writes output, passes --check, and detects drift without modifying the file", () => {
    const directory = mkdtempSync(join(tmpdir(), "harness-alert-generator-"));
    const outputPath = join(directory, "datadog-monitors.generated.json");
    const result = runAlertGenerator([], { thresholdsPath, outputPath });
    const generated = readFileSync(outputPath, "utf8");

    try {
      expect(result).toEqual({ exitCode: 0, stderr: "" });
      expect(runAlertGenerator(["--check"], { thresholdsPath, outputPath })).toEqual({
        exitCode: 0,
        stderr: "",
      });

      writeFileSync(outputPath, `${generated}stale`, "utf8");
      expect(runAlertGenerator(["--check"], { thresholdsPath, outputPath })).toEqual({
        exitCode: 1,
        stderr: "Datadog monitor JSON is stale; run `yarn gen:alerts`.\n",
      });
      expect(readFileSync(outputPath, "utf8")).toBe(`${generated}stale`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsupported arguments", () => {
    expect(runAlertGenerator(["--unknown"], { thresholdsPath, outputPath: "unused" })).toEqual({
      exitCode: 2,
      stderr: "Usage: yarn gen:alerts [--check]\n",
    });
  });
});
