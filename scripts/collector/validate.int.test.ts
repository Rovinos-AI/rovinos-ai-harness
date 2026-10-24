// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const projectName = `harness-otel-health-${String(process.pid)}`;
const commandOptions = {
  encoding: "utf8" satisfies BufferEncoding,
  maxBuffer: 10 * 1024 * 1024,
};

async function compose(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "compose",
      "--env-file",
      "infra/collector/VERSION",
      "--project-name",
      projectName,
      "--file",
      "infra/compose/docker-compose.test.yml",
      ...args,
    ],
    { ...commandOptions, cwd: root },
  );
  return requireStdout(stdout);
}

function requireStdout(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Docker command did not return text output.");
  }
  return value;
}

it("validates the base configuration and debug profile with the pinned collector", async () => {
  const validation = await execFileAsync(
    "bash",
    [resolve(root, "scripts/collector/validate.sh"), "debug"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  expect(typeof validation.stdout).toBe("string");
}, 120_000);

it("serves the health endpoint on a loopback-only published port", async () => {
  try {
    await compose(["up", "--detach", "--pull=never", "otel-collector"]);
    const containerId = (await compose(["ps", "--quiet", "otel-collector"])).trim();
    expect(containerId).not.toBe("");
    const readonlyRoot = await execFileAsync(
      "docker",
      ["inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}", containerId],
      commandOptions,
    );
    expect(requireStdout(readonlyRoot.stdout).trim()).toBe("true");
    const droppedCapabilities = await execFileAsync(
      "docker",
      ["inspect", "--format", '{{join .HostConfig.CapDrop ","}}', containerId],
      commandOptions,
    );
    expect(requireStdout(droppedCapabilities.stdout).trim()).toContain("ALL");
    const publishedPorts = await execFileAsync(
      "docker",
      ["inspect", "--format", "{{json .HostConfig.PortBindings}}", containerId],
      commandOptions,
    );
    expect(requireStdout(publishedPorts.stdout)).not.toContain('"8888/tcp"');

    const publishedPort = await compose(["port", "otel-collector", "13133"]);
    const hostPort = publishedPort.trim().split(":").at(-1);
    if (hostPort === undefined || !/^\d+$/u.test(hostPort)) {
      throw new Error("Collector health endpoint did not receive a published port");
    }

    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${hostPort}/`, {
          signal: AbortSignal.timeout(1_000),
        });
        healthy = response.status === 200;
        await response.body?.cancel();
        if (healthy) {
          break;
        }
      } catch {
        await setTimeout(250);
      }
    }
    expect(healthy).toBe(true);

    await compose([
      "up",
      "--wait",
      "--wait-timeout",
      "75",
      "--pull=never",
      "otel-health-wait",
    ]);
    const helperId = (await compose(["ps", "--quiet", "otel-health-wait"])).trim();
    expect(helperId).not.toBe("");
    const helperHealth = await execFileAsync(
      "docker",
      ["inspect", "--format", "{{.State.Health.Status}}", helperId],
      commandOptions,
    );
    expect(requireStdout(helperHealth.stdout).trim()).toBe("healthy");
  } finally {
    await compose(["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  }
}, 120_000);
