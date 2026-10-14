// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const projectName = `harness-prod-like-${String(process.pid)}`;
const runnerToken = randomBytes(32).toString("base64url");
const composeArgs = [
  "compose",
  "--env-file",
  "infra/collector/VERSION",
  "--project-name",
  projectName,
  "--file",
  "infra/compose/docker-compose.yml",
  "--file",
  "infra/compose/docker-compose.prod-like.yml",
  "--profile",
  "prod-like",
];
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 }).status === 0;

function compose(args: readonly string[]): string {
  return execFileSync("docker", [...composeArgs, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, SANDBOX_RUNNER_TOKEN: runnerToken },
  });
}

function inspect(service: string, format: string): string {
  const container = compose(["ps", "--quiet", service]).trim();
  expect(container).not.toBe("");
  return execFileSync("docker", ["inspect", "--format", format, container], {
    encoding: "utf8",
  }).trim();
}

describe.skipIf(!dockerAvailable)("prod-like Compose profile", () => {
  afterAll(() => {
    try {
      compose(["down", "--volumes", "--remove-orphans"]);
    } catch {
      // Cleanup is best-effort after a failed startup or health check.
    }
  });

  it("waits for service health and stops the harness cleanly within its grace period", () => {
    compose(["up", "--detach", "--wait", "--build"]);

    expect(inspect("harness", "{{.State.Health.Status}}")).toBe("healthy");
    expect(inspect("sandbox-runner", "{{.State.Health.Status}}")).toBe("healthy");

    const healthChecks = [
      "fetch('http://127.0.0.1:3000/mcp').then((response) => { if (response.status >= 500) process.exitCode = 1; })",
      "fetch('http://otel-collector:13133/').then((response) => { if (!response.ok) process.exitCode = 1; })",
    ].join(";");
    compose(["exec", "--no-TTY", "harness", "node", "-e", healthChecks]);
    const container = compose(["ps", "--quiet", "harness"]).trim();

    execFileSync("docker", ["stop", "--time", "30", container], { encoding: "utf8" });
    expect(
      execFileSync("docker", ["inspect", "--format", "{{.State.ExitCode}}", container], {
        encoding: "utf8",
      }).trim(),
    ).toBe("0");
  }, 180_000);
});
