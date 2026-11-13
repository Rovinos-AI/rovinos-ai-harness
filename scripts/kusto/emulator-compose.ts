// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));

async function compose(projectName: string, args: string[]): Promise<string> {
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
    },
  );
  return stdout;
}

/** Starts the isolated emulator and runs the selected schema or query contract client. */
export async function runKustoEmulatorComposeContract(
  projectName: string,
  client: "kusto-test-client" | "kusto-query-test-client" = "kusto-test-client",
): Promise<string> {
  try {
    return await compose(projectName, [
      "up",
      "--abort-on-container-exit",
      "--exit-code-from",
      client,
      client,
    ]);
  } finally {
    await compose(projectName, ["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  }
}
