// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const projectName = `harness-kusto-${String(process.pid)}`;

async function compose(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "compose",
      "--project-name",
      projectName,
      "--file",
      "infra/compose/docker-compose.test.yml",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return stdout;
}

async function emulatorAddress(): Promise<string> {
  const containerId = (await compose(["ps", "--quiet", "kusto-emulator"])).trim();
  if (containerId.length === 0) {
    throw new Error("kusto_emulator_container_missing");
  }
  const { stdout } = await execFileAsync(
    "docker",
    [
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      containerId,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const address = stdout.trim();
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(address)) {
    throw new Error("kusto_emulator_address_missing");
  }
  return address;
}

it(
  "applies the schema twice and ingests mapped rows in the Kusto emulator",
  async () => {
    try {
      await compose(["up", "--detach", "--wait", "--wait-timeout", "180", "kusto-emulator"]);
      const address = await emulatorAddress();
      const output = await compose([
        "run",
        "--rm",
        "--no-deps",
        "--env",
        `KUSTO_CLUSTER_URI=http://${address}:8080`,
        "kusto-test-client",
      ]);
      expect(output).toContain("kusto_emulator_contract_passed");
    } finally {
      await compose(["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
    }
  },
  240_000,
);
