// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { join } from "node:path";

interface SecretFiles {
  readonly runnerToken: string;
  readonly controlPlaneToken: string;
  readonly masterKey: string;
  readonly storeUrl: string;
  readonly vaultUrl: string;
  readonly postgresPassword: string;
}

interface MultiWorkerComposeOptions {
  readonly projectName: string;
  readonly root: string;
  readonly secretFiles: SecretFiles;
}

interface ComposeContext extends MultiWorkerComposeOptions {
  readonly composeArgs: readonly string[];
  readonly composeEnvironment: NodeJS.ProcessEnv;
}

interface RunHarnessScriptOptions {
  readonly name?: string;
  readonly detach?: boolean;
}

interface MultiWorkerCompose {
  readonly available: boolean;
  compose(args: readonly string[], timeout?: number): string;
  runHarnessScript(script: string, options?: RunHarnessScriptOptions): string;
  waitForLog(container: string, expected: string, timeoutMs?: number): Promise<string>;
  removeContainer(container: string): void;
  killContainer(container: string): void;
  stopContainer(container: string): void;
}

function createComposeContext(options: MultiWorkerComposeOptions): ComposeContext {
  return {
    ...options,
    composeArgs: [
      "compose",
      "--env-file",
      "infra/collector/VERSION",
      "--project-name",
      options.projectName,
      "--file",
      "infra/compose/docker-compose.yml",
      "--file",
      "infra/compose/docker-compose.prod-like.yml",
      "--profile",
      "prod-like",
    ],
    composeEnvironment: {
      ...process.env,
      SANDBOX_EGRESS_SUBNET: "172.31.251.0/24",
      SANDBOX_EGRESS_PROXY_IP: "172.31.251.3",
      EGRESS_TEST_SUBNET: "198.51.103.0/24",
      EGRESS_PROBE_IP: "198.51.103.3",
    },
  };
}

function compose(context: ComposeContext, args: readonly string[], timeout = 300_000): string {
  const environment = { ...context.composeEnvironment };
  delete environment.SANDBOX_RUNNER_TOKEN;
  environment.SANDBOX_RUNNER_TOKEN_SECRET_FILE = context.secretFiles.runnerToken;
  environment.CONTROL_PLANE_TOKEN_SECRET_FILE = context.secretFiles.controlPlaneToken;
  environment.HARNESS_MASTER_KEY_SECRET_FILE = context.secretFiles.masterKey;
  environment.HARNESS_STORE_DATABASE_URL_SECRET_FILE = context.secretFiles.storeUrl;
  environment.HARNESS_VAULT_DATABASE_URL_SECRET_FILE = context.secretFiles.vaultUrl;
  environment.POSTGRES_PASSWORD_SECRET_FILE = context.secretFiles.postgresPassword;
  return execFileSync("docker", [...context.composeArgs, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: environment,
    timeout,
  });
}

function postgresAddress(context: ComposeContext): string {
  const postgresContainer = compose(context, ["ps", "--quiet", "postgres"]).trim();
  const address = execFileSync(
    "docker",
    [
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${context.projectName}_internal").IPAddress}}`,
      postgresContainer,
    ],
    { encoding: "utf8" },
  ).trim();
  if (isIP(address) !== 4) {
    throw new Error("multi_worker_postgres_address_unavailable");
  }
  return address;
}

function sandboxRunnerAddress(
  context: ComposeContext,
  service: "sandbox-runner" | "sandbox-runner-2",
): string {
  const runnerContainer = compose(context, ["ps", "--quiet", service]).trim();
  const address = execFileSync(
    "docker",
    [
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${context.projectName}_sandbox").IPAddress}}`,
      runnerContainer,
    ],
    { encoding: "utf8" },
  ).trim();
  if (isIP(address) !== 4) {
    throw new Error("multi_worker_runner_address_unavailable");
  }
  return address;
}

function createScriptContainerArgs(
  context: ComposeContext,
  containerName: string,
  script: string,
): string[] {
  const secrets: readonly [string, string][] = [
    ["sandbox_runner_token", context.secretFiles.runnerToken],
    ["control_plane_token", context.secretFiles.controlPlaneToken],
    ["harness_master_key", context.secretFiles.masterKey],
    ["store_database_url", context.secretFiles.storeUrl],
    ["vault_database_url", context.secretFiles.vaultUrl],
    ["postgres_password", context.secretFiles.postgresPassword],
  ];
  return [
    "create",
    "--name",
    containerName,
    "--network",
    `${context.projectName}_internal`,
    "--add-host",
    `postgres:${postgresAddress(context)}`,
    "--add-host",
    `sandbox-runner:${sandboxRunnerAddress(context, "sandbox-runner")}`,
    "--add-host",
    `sandbox-runner-2:${sandboxRunnerAddress(context, "sandbox-runner-2")}`,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--tmpfs",
    "/var/lib/harness/event-store:rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--pids-limit",
    "128",
    "--env",
    "HARNESS_CONFIG=/run/prod-like.yaml",
    "--env",
    "HARNESS_DATA_DIR=/var/lib/harness/event-store",
    "--mount",
    `type=bind,source=${join(context.root, "test/fixtures/prod-like-multi.yaml")},target=/run/prod-like.yaml,readonly`,
    ...secrets.flatMap(([name, path]) => [
      "--mount",
      `type=bind,source=${path},target=/run/secrets/${name},readonly`,
    ]),
    "--entrypoint",
    "node",
    "harness:local",
    "--input-type=module",
    "-e",
    script,
  ];
}

function runHarnessScript(
  context: ComposeContext,
  containerName: string,
  script: string,
  detach: boolean,
): string {
  execFileSync("docker", createScriptContainerArgs(context, containerName, script), {
    encoding: "utf8",
  });
  execFileSync("docker", ["network", "connect", `${context.projectName}_sandbox`, containerName], {
    encoding: "utf8",
  });
  if (detach) {
    execFileSync("docker", ["start", containerName], { encoding: "utf8" });
    return containerName;
  }
  try {
    return execFileSync("docker", ["start", "--attach", containerName], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
  } finally {
    execFileSync("docker", ["rm", "-f", containerName], { encoding: "utf8" });
  }
}

async function waitForLog(
  container: string,
  expected: string,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const logs = execFileSync("docker", ["logs", container], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      if (logs.includes(expected)) {
        return logs;
      }
    } catch {
      // The container may not have emitted logs yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("multi_worker_container_timeout");
}

/**
 * Creates Docker helpers for the multi-worker Compose integration suite.
 *
 * @param options - Compose project, repository root, and generated secret paths.
 * @returns Docker operations used by the integration suite.
 */
export function createMultiWorkerCompose(options: MultiWorkerComposeOptions): MultiWorkerCompose {
  const context = createComposeContext(options);
  let scriptContainerSequence = 0;
  return {
    available: spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 }).status === 0,
    compose: (args, timeout) => compose(context, args, timeout),
    runHarnessScript: (script, runOptions = {}) => {
      const containerName =
        runOptions.name ??
        `${context.projectName}-script-${String(process.pid)}-${String(++scriptContainerSequence)}`;
      return runHarnessScript(context, containerName, script, runOptions.detach === true);
    },
    waitForLog,
    removeContainer: (container) => {
      execFileSync("docker", ["rm", "-f", container], { encoding: "utf8" });
    },
    killContainer: (container) => {
      execFileSync("docker", ["kill", container], { encoding: "utf8" });
    },
    stopContainer: (container) => {
      execFileSync("docker", ["stop", "--time", "5", container], { encoding: "utf8" });
    },
  };
}
