// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "@rovinos/schemas";
import { AlertThresholdsSchema, type AlertThresholds } from "./contracts.ts";
import { createDatadogMonitors } from "./template.ts";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const defaultThresholdsPath = resolve(rootDirectory, "infra/alerts/thresholds.yaml");
const defaultOutputPath = resolve(rootDirectory, "infra/alerts/datadog-monitors.generated.json");

/** Files used by the alert generator. */
export interface AlertGeneratorPaths {
  readonly thresholdsPath: string;
  readonly outputPath: string;
}

/** Result of running the alert generator command. */
export interface AlertGeneratorResult {
  readonly exitCode: number;
  readonly stderr: string;
}

/** Renders deterministic Datadog monitor JSON from validated thresholds. */
export function renderDatadogMonitors(thresholds: AlertThresholds): string {
  return `${JSON.stringify(createDatadogMonitors(thresholds), null, 2)}\n`;
}

/** Generates committed monitor JSON or reports drift when invoked with `--check`. */
export function runAlertGenerator(
  args: readonly string[],
  paths: AlertGeneratorPaths = {
    thresholdsPath: defaultThresholdsPath,
    outputPath: defaultOutputPath,
  },
): AlertGeneratorResult {
  if (args.length > 1 || args.some((argument) => argument !== "--check")) {
    return { exitCode: 2, stderr: "Usage: yarn gen:alerts [--check]\n" };
  }

  let generated: string;
  try {
    const thresholds = parseYaml(AlertThresholdsSchema, readFileSync(paths.thresholdsPath, "utf8"));
    generated = renderDatadogMonitors(thresholds);
  } catch {
    return { exitCode: 1, stderr: "Alert thresholds are invalid or unavailable.\n" };
  }

  if (args.includes("--check")) {
    try {
      if (readFileSync(paths.outputPath, "utf8") !== generated) {
        return { exitCode: 1, stderr: "Datadog monitor JSON is stale; run `yarn gen:alerts`.\n" };
      }
    } catch {
      return { exitCode: 1, stderr: "Datadog monitor JSON is missing.\n" };
    }
    return { exitCode: 0, stderr: "" };
  }

  mkdirSync(dirname(paths.outputPath), { recursive: true });
  writeFileSync(paths.outputPath, generated, "utf8");
  return { exitCode: 0, stderr: "" };
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  const result = runAlertGenerator(process.argv.slice(2));
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}
