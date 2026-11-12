// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));

async function compose(
  projectName: string,
  args: string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "compose",
      "--profile",
      "kusto-contract",
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
      env: { ...process.env, ...environment },
    },
  );
  return stdout;
}

async function emulatorAddress(projectName: string): Promise<string> {
  const containerId = (await compose(projectName, ["ps", "--quiet", "kusto-emulator"])).trim();
  if (containerId.length === 0) {
    throw new TypeError("kusto_emulator_container_missing");
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
  if (isIP(address) !== 4) {
    throw new TypeError("kusto_emulator_address_missing");
  }
  return address;
}

/** Starts the isolated emulator and runs its schema and ingestion contract client. */
export async function runKustoEmulatorComposeContract(projectName: string): Promise<string> {
  try {
    await compose(projectName, [
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "180",
      "kusto-emulator",
    ]);
    const address = await emulatorAddress(projectName);
    return await compose(
      projectName,
      [
        "run",
        "--rm",
        "--no-deps",
        "--use-aliases",
        "--env",
        "KUSTO_CLUSTER_URI=http://kusto-emulator:8080",
        "--env",
        "KUSTO_DATABASE=NetDefaultDB",
        "kusto-test-client",
      ],
      { KUSTO_EMULATOR_IP: address },
    );
  } finally {
    await compose(projectName, ["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  }
}
