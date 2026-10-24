// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

function capturedOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return stdout + stderr;
}

it("validates every profile and verifies the pinned collector components", async () => {
  const environment = {
    ...process.env,
    DD_API_KEY: "test-api-key",
    DD_SITE: "datadoghq.com",
    ADX_CLUSTER_URI: "https://example.kusto.windows.net",
    ADX_DATABASE: "HarnessTests",
    ADX_MANAGED_IDENTITY_ID: "system",
  };
  const validationOptions = {
    cwd: root,
    encoding: "utf8" as const,
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
  };

  for (const profile of ["debug", "datadog", "adx", "test"]) {
    const validation = await execFileAsync(
      "bash",
      [resolve(root, "scripts/collector/validate.sh"), profile],
      validationOptions,
    );
    expect(typeof validation.stdout).toBe("string");
  }

  const verification = await execFileAsync(
    "bash",
    [resolve(root, "scripts/collector/verify-components.sh")],
    validationOptions,
  );
  expect(typeof verification.stdout).toBe("string");
}, 120_000);

it("prints the builder fallback when a required component is missing", async () => {
  const fakeDockerDirectory = mkdtempSync(resolve(tmpdir(), "collector-docker-"));
  const fakeDocker = resolve(fakeDockerDirectory, "docker");
  writeFileSync(
    fakeDocker,
    `#!/bin/sh
cat <<'COMPONENTS'
exporters:
    - name: azuredataexplorer
    - name: file
    - name: debug
processors:
    - name: transform
    - name: filter
    - name: memory_limiter
    - name: batch
COMPONENTS
`,
    { mode: 0o755 },
  );

  try {
    const result = await execFileAsync(
      "bash",
      [resolve(root, "scripts/collector/verify-components.sh")],
      {
        ...commandOptions,
        cwd: root,
        env: { ...process.env, PATH: `${fakeDockerDirectory}:${process.env.PATH ?? ""}` },
      },
    ).then(
      () => ({ succeeded: true, output: "" }),
      (error: unknown) => ({ succeeded: false, output: capturedOutput(error) }),
    );

    expect(result.succeeded).toBe(false);
    expect(result.output).toContain("missing exporter datadog");
    expect(result.output).toContain("infra/collector/builder.yaml");
  } finally {
    rmSync(fakeDockerDirectory, { recursive: true, force: true });
  }
});

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

    await compose(["up", "--wait", "--wait-timeout", "75", "--pull=never", "otel-health-wait"]);
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
