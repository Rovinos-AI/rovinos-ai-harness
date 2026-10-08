// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const composeFile = "infra/compose/docker-compose.yml";
const imageName = `harness:integration-${String(process.pid)}`;
const projectName = `harness-docker-${String(process.pid)}`;
const composeEnvironment = { ...process.env, HARNESS_IMAGE: imageName };
let imageBuilt = false;
let composeStarted = false;

describe("Docker image", () => {
  beforeAll(() => {
    runDocker(["build", "--tag", imageName, "--file", "Dockerfile", "."]);
    imageBuilt = true;
  }, 300_000);

  afterAll(() => {
    if (composeStarted) {
      runDocker(
        ["compose", "--project-name", projectName, "--file", composeFile, "down", "--volumes"],
        composeEnvironment,
      );
    }
    if (imageBuilt) {
      runDocker(["image", "rm", "--force", imageName]);
    }
  }, 60_000);

  it("runs as a non-root user and prints a semantic version", () => {
    const uid = runDocker(["run", "--rm", "--entrypoint", "id", imageName, "-u"]).trim();
    expect(uid).not.toBe("0");

    const version = runDocker(["run", "--rm", imageName, "--version"]).trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("starts healthy with a read-only root filesystem under Compose", () => {
    composeStarted = true;
    runDocker(
      [
        "compose",
        "--project-name",
        projectName,
        "--file",
        composeFile,
        "up",
        "--wait",
        "--no-build",
      ],
      composeEnvironment,
    );
    const containerId = runDocker(
      ["compose", "--project-name", projectName, "--file", composeFile, "ps", "--quiet", "harness"],
      composeEnvironment,
    ).trim();

    expect(containerId).not.toBe("");
    expect(
      runDocker(["inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}", containerId]).trim(),
    ).toBe("true");
    expect(runDocker(["inspect", "--format", "{{.State.Health.Status}}", containerId]).trim()).toBe(
      "healthy",
    );
  }, 30_000);
});

function runDocker(args: string[], environment: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
  });
}
