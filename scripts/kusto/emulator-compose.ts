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

/** Starts the isolated emulator and runs its schema and ingestion contract client. */
export async function runKustoEmulatorComposeContract(projectName: string): Promise<string> {
  try {
    return await compose(projectName, [
      "up",
      "--abort-on-container-exit",
      "--exit-code-from",
      "kusto-test-client",
      "kusto-test-client",
    ]);
  } finally {
    await compose(projectName, ["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  }
}

/** Starts the isolated emulator and runs all Kusto query fixtures and golden contracts. */
export async function runKustoEmulatorComposeQueriesContract(projectName: string): Promise<string> {
  try {
    return await compose(projectName, [
      "up",
      "--abort-on-container-exit",
      "--exit-code-from",
      "kusto-query-test-client",
      "kusto-query-test-client",
    ]);
  } finally {
    await compose(projectName, ["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  }
}
