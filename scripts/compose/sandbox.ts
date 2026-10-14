// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@harness/config";
import type { HarnessConfig } from "@harness/config";

/** Docker Compose arguments and environment rendered from sandbox config. */
export interface SandboxComposeInvocation {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Builds the sandbox Compose invocation, enabling egress only for a non-empty allowlist.
 *
 * @param egress - Optional egress configuration loaded from harness config.
 * @param composeArgs - Docker Compose subcommand and remaining arguments.
 * @param environment - Environment inherited by the Docker Compose process.
 * @returns Compose arguments and a copy of the environment with the config-derived allowlist.
 */
export function createSandboxComposeInvocation(
  egress: HarnessConfig["sandbox"]["egress"],
  composeArgs: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): SandboxComposeInvocation {
  const allow = egress?.allow ?? [];
  const env = { ...environment };
  const args = [
    "compose",
    "--env-file",
    "infra/collector/VERSION",
    "--profile",
    "sandbox",
    "--file",
    "infra/compose/docker-compose.yml",
  ];

  if (allow.length > 0) {
    env.SANDBOX_EGRESS_ALLOW = JSON.stringify(allow);
    args.push("--profile", "sandbox-egress", "--file", "infra/compose/docker-compose.egress.yml");
  } else {
    delete env.SANDBOX_EGRESS_ALLOW;
    delete env.SANDBOX_EGRESS_PROXY_URL;
  }

  return { args: [...args, ...composeArgs], env };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = await loadConfig();
  const invocation = createSandboxComposeInvocation(config.sandbox.egress, process.argv.slice(2));
  execFileSync("docker", [...invocation.args], {
    env: invocation.env,
    stdio: "inherit",
  });
}
