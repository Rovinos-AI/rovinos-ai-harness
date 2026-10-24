// SPDX-License-Identifier: Apache-2.0
// Docker calls are asynchronous on purpose: a cold image build can take minutes, and a
// synchronous child process would block the Vitest worker long enough for its RPC to time out.
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HARNESS_VERSION } from "@rovinos/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const composeFile = "infra/compose/docker-compose.test.yml";
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
          [
            "compose",
            "--env-file",
            "infra/collector/VERSION",
            "--project-name",
            projectName,
            "--file",
            composeFile,
            "down",
            "--volumes",
          ],
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

  it("includes both dialect migrations and opens a SQLite store", async () => {
    const assets = await runDocker([
      "run",
      "--rm",
      "--entrypoint",
      "node",
      imageName,
      "--input-type=module",
      "-e",
      "import { existsSync } from 'node:fs'; const paths = ['/app/migrations/sqlite/0001_init.sql', '/app/migrations/postgres/0001_init.sql', '/app/migrations/vault/sqlite/0001_init.sql', '/app/migrations/vault/postgres/0001_init.sql', '/app/packages/approval-app/dist/approval.html', '/app/packages/approval-app/dist/runs-console.html', '/app/web/index.html', '/app/web/host.js']; if (paths.some((path) => !existsSync(path))) throw new Error('runtime_assets_missing'); process.stdout.write('runtime_assets_ok');",
    ]);
    expect(assets.trim()).toBe("runtime_assets_ok");

    const migrationOutput = await runDocker([
      "run",
      "--rm",
      "--env",
      "HARNESS_DATA_DIR=/tmp/harness-store-image-smoke",
      imageName,
      "--json",
      "store",
      "migrate",
    ]);
    expect(migrationOutput).toContain('"0009"');
  });

  it("starts the bundled HTTP server with package-relative runtime assets", async () => {
    const temporaryDirectory = join(repositoryRoot, ".tmp");
    await mkdir(temporaryDirectory, { recursive: true });
    const secretDirectory = await mkdtemp(join(temporaryDirectory, "docker-image-secret-"));
    const containerName = `${projectName}-serve`;
    await chmod(secretDirectory, 0o755);
    await writeFile(
      join(secretDirectory, "control_plane_token"),
      "synthetic-image-test-token-0123456789",
      { mode: 0o444 },
    );
    try {
      await runDocker([
        "run",
        "--detach",
        "--name",
        containerName,
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m",
        "--env",
        "HARNESS_CONFIG=/run/control-plane.yaml",
        "--env",
        "HARNESS_DATA_DIR=/tmp/harness",
        "--mount",
        `type=bind,source=${join(repositoryRoot, "test/fixtures/control-plane-auth.yaml")},target=/run/control-plane.yaml,readonly`,
        "--mount",
        `type=bind,source=${secretDirectory},target=/run/secrets,readonly`,
        imageName,
        "serve",
        "--http",
        "--port",
        "0",
      ]);

      const deadline = Date.now() + 30_000;
      let output = "";
      while (Date.now() < deadline) {
        output = await runDocker(["logs", containerName]);
        if (output.includes("http://127.0.0.1:")) {
          break;
        }
        const status = (
          await runDocker(["inspect", "--format", "{{.State.Status}}", containerName])
        ).trim();
        if (status !== "running") {
          const exitCode = (
            await runDocker(["inspect", "--format", "{{.State.ExitCode}}", containerName])
          ).trim();
          throw new Error(`bundled_server_exited:${status}:${exitCode}:${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(output).toContain("http://127.0.0.1:");
    } finally {
      await runDocker(["rm", "--force", containerName]).catch(() => "");
      await rm(secretDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("starts healthy with a read-only root filesystem under Compose", async () => {
    composeStarted = true;
    await runDocker(
      [
        "compose",
        "--env-file",
        "infra/collector/VERSION",
        "--project-name",
        projectName,
        "--file",
        composeFile,
        "up",
        "--wait",
        "--no-build",
        "--pull=never",
        "harness",
      ],
      composeEnvironment,
    );
    const containerId = (
      await runDocker(
        [
          "compose",
          "--env-file",
          "infra/collector/VERSION",
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
