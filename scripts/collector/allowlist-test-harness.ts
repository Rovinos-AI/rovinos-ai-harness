// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const signalNames = ["traces", "logs", "metrics"] as const;

/** OTLP request data sent to the collector fixture container. */
export interface CollectorFixturePayload {
  readonly signal: (typeof signalNames)[number];
  readonly body: string;
}

/** JSON-lines output files produced by the collector fixture container. */
export interface CollectorFixtureOutput {
  readonly traces: string;
  readonly logs: string;
  readonly metrics: string;
}

function docker(args: string[]): Promise<string> {
  return execFileAsync("docker", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }).then(({ stdout }) => stdout);
}

function mappedPort(output: string): number {
  const match = /:(\d+)$/u.exec(output.trim());
  if (match === null) {
    throw new Error("Collector port was not published.");
  }
  return Number(match[1]);
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.status === 200) {
        return;
      }
    } catch {
      await setTimeout(250);
    }
  }
  throw new Error("Collector did not become healthy within the polling deadline.");
}

async function startCollector(
  name: string,
  outputDirectory: string,
  protectedProfile: boolean,
): Promise<string> {
  const version = readFileSync(join(root, "infra/collector/VERSION"), "utf8");
  const image = /^OTEL_COLLECTOR_IMAGE=(\S+)$/mu.exec(version)?.[1];
  if (image === undefined) {
    throw new Error("Pinned collector image is missing.");
  }
  const configs = [
    "infra/collector/base.yaml",
    ...(protectedProfile
      ? [
          "infra/collector/allowlist.generated.yaml",
          "infra/collector/policy-version.generated.yaml",
        ]
      : []),
    protectedProfile
      ? "infra/collector/profile-test.yaml"
      : "test/fixtures/collector-unfiltered.yaml",
  ];
  const dockerArgs = [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--publish",
    "127.0.0.1::4318",
    "--publish",
    "127.0.0.1::13133",
    "--volume",
    `${outputDirectory}:/var/otel-out`,
  ];
  const collectorArgs: string[] = [];
  for (const [index, config] of configs.entries()) {
    const fileName = config.split("/").at(-1) ?? "config.yaml";
    const containerPath = `/etc/otel/${String(index)}-${fileName}`;
    dockerArgs.push("--volume", `${join(root, config)}:${containerPath}:ro`);
    collectorArgs.push(`--config=${containerPath}`);
  }
  await docker([...dockerArgs, image, ...collectorArgs]);

  const otlpPort = mappedPort(await docker(["port", name, "4318/tcp"]));
  const healthPort = mappedPort(await docker(["port", name, "13133/tcp"]));
  await waitForHealth(`http://127.0.0.1:${String(healthPort)}/`);
  return `http://127.0.0.1:${String(otlpPort)}`;
}

async function sendPayload(endpoint: string, payload: CollectorFixturePayload): Promise<void> {
  const response = await fetch(`${endpoint}/v1/${payload.signal}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload.body,
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (response.status !== 200) {
    throw new Error("Collector rejected an OTLP fixture payload.");
  }
}

function readOutputs(directory: string): CollectorFixtureOutput {
  const outputs: Record<(typeof signalNames)[number], string> = {
    traces: "",
    logs: "",
    metrics: "",
  };
  for (const signal of signalNames) {
    const path = join(directory, `${signal}.jsonl`);
    outputs[signal] = existsSync(path) ? readFileSync(path, "utf8") : "";
  }
  return outputs;
}

async function waitForOutputs(directory: string): Promise<CollectorFixtureOutput> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const outputs = readOutputs(directory);
    if (signalNames.every((signal) => outputs[signal].length > 0)) {
      return outputs;
    }
    await setTimeout(250);
  }
  throw new Error("Collector did not flush its output within the polling deadline.");
}

async function stopCollector(name: string): Promise<void> {
  await docker(["stop", "--time", "2", name]).catch(() => undefined);
}

/** Runs one isolated collector, sending OTLP/HTTP fixtures and returning flushed JSON-lines output. */
export async function runCollectorFixture(
  name: string,
  protectedProfile: boolean,
  payloads: readonly CollectorFixturePayload[],
): Promise<CollectorFixtureOutput> {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "collector-allowlist-"));
  const outputDirectory = join(temporaryDirectory, "output");
  mkdirSync(outputDirectory);
  chmodSync(outputDirectory, 0o777);
  try {
    const endpoint = await startCollector(name, outputDirectory, protectedProfile);
    for (const payload of payloads) {
      await sendPayload(endpoint, payload);
    }
    return await waitForOutputs(outputDirectory);
  } finally {
    await stopCollector(name);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
