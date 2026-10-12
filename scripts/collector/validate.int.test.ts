// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const collectorDirectory = resolve(root, "infra/collector");
const containerName = `harness-otel-health-${String(process.pid)}`;
const commandOptions = {
  encoding: "utf8" satisfies BufferEncoding,
  maxBuffer: 10 * 1024 * 1024,
};

async function readCollectorImage(): Promise<string> {
  const versionFile = await readFile(resolve(collectorDirectory, "VERSION"), "utf8");
  const match = /^OTEL_COLLECTOR_IMAGE=(\S+)$/mu.exec(versionFile);
  if (match?.[1] === undefined) {
    throw new Error("infra/collector/VERSION does not contain the collector image");
  }
  return match[1];
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
  const image = await readCollectorImage();
  await execFileAsync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--volume",
      `${collectorDirectory}:/etc/otel:ro`,
      "--publish",
      "127.0.0.1::13133",
      image,
      "--config=/etc/otel/base.yaml",
      "--config=/etc/otel/profile-debug.yaml",
    ],
    commandOptions,
  );

  try {
    const publishedPort = await execFileAsync(
      "docker",
      ["port", containerName, "13133/tcp"],
      commandOptions,
    );
    const publishedAddress = typeof publishedPort.stdout === "string" ? publishedPort.stdout : "";
    const hostPort = publishedAddress.trim().split(":").at(-1);
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
  } finally {
    await execFileAsync("docker", ["rm", "--force", containerName], commandOptions).catch(
      () => undefined,
    );
  }
}, 60_000);
