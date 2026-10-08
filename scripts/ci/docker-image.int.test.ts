// SPDX-License-Identifier: Apache-2.0
// Docker calls are asynchronous on purpose: a cold image build can take minutes, and a
// synchronous child process would block the Vitest worker long enough for its RPC to time out.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HARNESS_VERSION } from "@harness/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const composeFile = "infra/compose/docker-compose.yml";
const imageName = `harness:integration-${String(process.pid)}`;
const projectName = `harness-docker-${String(process.pid)}`;
const composeEnvironment = { ...process.env, HARNESS_IMAGE: imageName };
let imageBuilt = false;
let composeStarted = false;

describe("Docker image", () => {
  beforeAll(async () => {
    await runDocker(["build", "--tag", imageName, "--file", "Dockerfile", "."]);
    imageBuilt = true;
  }, 300_000);

  afterAll(async () => {
    try {
      if (composeStarted) {
        await runDocker(
          ["compose", "--project-name", projectName, "--file", composeFile, "down", "--volumes"],
          composeEnvironment,
        );
      }
    } finally {
      if (imageBuilt) {
        await runDocker(["image", "rm", "--force", imageName]);
      }
    }
  }, 60_000);

  it("runs as a non-root user and prints a semantic version", async () => {
    const uid = (await runDocker(["run", "--rm", "--entrypoint", "id", imageName, "-u"])).trim();
    expect(uid).not.toBe("0");

    const version = (await runDocker(["run", "--rm", imageName, "--version"])).trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).toBe(HARNESS_VERSION);
  });

  it("starts healthy with a read-only root filesystem under Compose", async () => {
    composeStarted = true;
    await runDocker(
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
    const containerId = (
      await runDocker(
        [
          "compose",
          "--project-name",
          projectName,
          "--file",
          composeFile,
          "ps",
          "--quiet",
          "harness",
        ],
        composeEnvironment,
      )
    ).trim();

    expect(containerId).not.toBe("");
    expect(
      (
        await runDocker(["inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}", containerId])
      ).trim(),
    ).toBe("true");
    expect(
      (await runDocker(["inspect", "--format", "{{.State.Health.Status}}", containerId])).trim(),
    ).toBe("healthy");
    await runDocker(["stop", "--time", "2", containerId]);
    expect(
      (await runDocker(["inspect", "--format", "{{.State.ExitCode}}", containerId])).trim(),
    ).toBe("0");
  }, 60_000);
});

async function runDocker(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}
