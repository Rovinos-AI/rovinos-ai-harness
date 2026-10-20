// SPDX-License-Identifier: Apache-2.0
// threat: T-02
// threat: T-15
// threat: T-16
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const revision = `image-hardening-test-${String(process.pid)}`;
const images = [
  { dockerfile: "Dockerfile", image: `harness:hardening-${String(process.pid)}` },
  { dockerfile: "Dockerfile.sandbox", image: `harness-sandbox:hardening-${String(process.pid)}` },
];
const source = "https://github.com/Rovinos-AI/rovinos-ai-harness";
const secretAssignmentPattern = /\b\w*(?:KEY|TOKEN)\s*=\s*["']?(?!\$)[^\s"']+/i;
const labelsFormat =
  '{{ index .Config.Labels "org.opencontainers.image.source" }}|{{ index .Config.Labels "org.opencontainers.image.licenses" }}|{{ index .Config.Labels "org.opencontainers.image.revision" }}';
const builtImages = new Set<string>();

describe("hardened container images", () => {
  beforeAll(async () => {
    for (const { dockerfile, image } of images) {
      await runDocker([
        "build",
        "--build-arg",
        `REVISION=${revision}`,
        "--tag",
        image,
        "--file",
        dockerfile,
        ".",
      ]);
      builtImages.add(image);
    }
  }, 600_000);

  afterAll(async () => {
    for (const image of builtImages) {
      await runDocker(["image", "rm", "--force", image]);
    }
  }, 60_000);

  it.each(images)(
    "$dockerfile is non-root, capability-limited, and contains no setuid files",
    async ({ image }) => {
      const uid = await runImage(
        image,
        ["--entrypoint", "node"],
        ["-e", "process.stdout.write(String(process.getuid()))"],
      );
      expect(uid.trim()).not.toBe("0");

      const capabilities = await runImage(
        image,
        ["--cap-drop", "ALL", "--entrypoint", "node"],
        [
          "-e",
          "const status = require('node:fs').readFileSync('/proc/self/status', 'utf8'); const effective = status.match(/^CapEff:\\s*([0-9a-f]+)$/m)?.[1]; if (effective !== '0000000000000000') process.exit(1);",
        ],
      );
      expect(capabilities).toBe("");

      const setuidFiles = await runImage(
        image,
        ["--user", "0:0", "--entrypoint", "find"],
        ["/", "-xdev", "-perm", "/6000", "-type", "f", "-print", "-quit"],
      );
      expect(setuidFiles.trim()).toBe("");
    },
  );

  it.each(images)(
    "$dockerfile refuses root-filesystem writes and has no Docker CLI",
    async ({ image }) => {
      const readonlyWrite = await runImage(
        image,
        ["--read-only", "--cap-drop", "ALL", "--user", "0:0", "--entrypoint", "node"],
        [
          "-e",
          "try { require('node:fs').writeFileSync('/.harness-hardening-probe', 'x'); process.exit(1); } catch (error) { if (error.code !== 'EROFS') process.exit(2); }",
        ],
      );
      expect(readonlyWrite).toBe("");

      const dockerCli = await runImage(
        image,
        ["--entrypoint", "node"],
        [
          "-e",
          "const result = require('node:child_process').spawnSync('docker', ['--version']); if (result.error?.code !== 'ENOENT') process.exit(1);",
        ],
      );
      expect(dockerCli).toBe("");
    },
  );

  it.each(images)(
    "$dockerfile has the expected OCI labels and no literal secrets in history",
    async ({ image }) => {
      const labels = (
        await runDocker(["image", "inspect", "--format", labelsFormat, image])
      ).trim();
      expect(labels).toBe(`${source}|Apache-2.0|${revision}`);

      const history = await runDocker([
        "history",
        "--no-trunc",
        "--format",
        "{{.CreatedBy}}",
        image,
      ]);
      expect(secretAssignmentPattern.test(history)).toBe(false);
    },
  );
});

async function runImage(image: string, options: string[], command: string[]): Promise<string> {
  return runDocker(["run", "--rm", ...options, image, ...command]);
}

async function runDocker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}
