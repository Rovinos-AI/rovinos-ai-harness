// SPDX-License-Identifier: Apache-2.0
import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseJson } from "@harness/schemas";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const composeConfigSchema = z.object({
  networks: z.record(z.string(), z.object({ internal: z.boolean().optional() })),
  services: z.record(
    z.string(),
    z.object({ networks: z.record(z.string(), z.unknown()).optional() }),
  ),
});

/** Renders the main Compose test profile's network configuration for integration checks. */
export function readRenderedComposeNetworkConfig(): z.infer<typeof composeConfigSchema> {
  const rendered = execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      "infra/collector/VERSION",
      "--profile",
      "sandbox",
      "--file",
      "infra/compose/docker-compose.test.yml",
      "config",
      "--format",
      "json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  return parseJson(composeConfigSchema, rendered);
}

/** Runs a command against the isolated network fixture's Compose project. */
export async function runNetworkIsolationCompose(
  projectName: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "compose",
      "--env-file",
      "infra/collector/VERSION",
      "--project-name",
      projectName,
      "--file",
      "infra/compose/docker-compose.yml",
      "--file",
      "infra/compose/docker-compose.isolation.test.yml",
      ...args,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (typeof stdout !== "string") {
    throw new TypeError("Docker command did not return text output.");
  }
  return stdout;
}
