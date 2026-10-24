// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { InspectResultSchema, RunResultSchema, parseJson } from "@harness/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectName = `harness-prod-like-${String(process.pid)}`;
const runnerToken = randomBytes(32).toString("base64url");
const controlPlaneToken = randomBytes(32).toString("base64url");
let secretDirectory = "";
let runnerTokenFile = "";
let controlPlaneTokenFile = "";
let masterKeyFile = "";
let storeUrlFile = "";
let vaultUrlFile = "";
let postgresPasswordFile = "";
let prodLikeConfigFile = "";
const composeArgs = [
  "compose",
  "--env-file",
  "infra/collector/VERSION",
  "--project-name",
  projectName,
  "--file",
  "infra/compose/docker-compose.yml",
  "--file",
  "infra/compose/docker-compose.prod-like.yml",
  "--profile",
  "prod-like",
];
const composeEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  SANDBOX_EGRESS_SUBNET: "172.31.251.0/24",
  SANDBOX_EGRESS_PROXY_IP: "172.31.251.3",
  EGRESS_TEST_SUBNET: "198.51.103.0/24",
  EGRESS_PROBE_IP: "198.51.103.3",
};
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 }).status === 0;

function compose(args: readonly string[], timeout = 300_000): string {
  const environment = { ...composeEnvironment };
  delete environment.SANDBOX_RUNNER_TOKEN;
  environment.SANDBOX_RUNNER_TOKEN_SECRET_FILE = runnerTokenFile;
  environment.CONTROL_PLANE_TOKEN_SECRET_FILE = controlPlaneTokenFile;
  environment.HARNESS_MASTER_KEY_SECRET_FILE = masterKeyFile;
  environment.HARNESS_STORE_DATABASE_URL_SECRET_FILE = storeUrlFile;
  environment.HARNESS_VAULT_DATABASE_URL_SECRET_FILE = vaultUrlFile;
  environment.POSTGRES_PASSWORD_SECRET_FILE = postgresPasswordFile;
  environment.PROD_LIKE_CONFIG_FILE = prodLikeConfigFile;
  return execFileSync("docker", [...composeArgs, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: environment,
    timeout,
  });
}

function inspect(service: string, format: string): string {
  const container = compose(["ps", "--quiet", service]).trim();
  expect(container).not.toBe("");
  return execFileSync("docker", ["inspect", "--format", format, container], {
    encoding: "utf8",
  }).trim();
}

function serviceAddress(service: string, network: string): string {
  const address = inspect(
    service,
    `{{(index .NetworkSettings.Networks "${projectName}_${network}").IPAddress}}`,
  );
  expect(isIP(address)).toBe(4);
  return address;
}

describe.skipIf(!dockerAvailable)("prod-like Compose profile", () => {
  afterAll(() => {
    try {
      compose(["down", "--volumes", "--remove-orphans"], 120_000);
    } catch {
      // Cleanup is best-effort after a failed startup or health check.
    }
  }, 150_000);

  beforeAll(async () => {
    // Docker bind-mounts the secret file. Colima shares only $HOME with its VM, so os.tmpdir()
    // (/var/folders on macOS) cannot be mounted; use a gitignored directory inside the checkout.
    const mountableTemp = join(process.cwd(), ".tmp");
    await mkdir(mountableTemp, { recursive: true });
    secretDirectory = await mkdtemp(join(mountableTemp, "harness-prod-like-"));
    runnerTokenFile = resolvePath(secretDirectory, "sandbox-runner-token");
    await writeFile(runnerTokenFile, runnerToken, { encoding: "utf8", mode: 0o444 });
    controlPlaneTokenFile = resolvePath(secretDirectory, "control-plane-token");
    await writeFile(controlPlaneTokenFile, controlPlaneToken, { encoding: "utf8", mode: 0o444 });
    masterKeyFile = resolvePath(secretDirectory, "harness-master-key");
    const masterKey = randomBytes(32).toString("base64");
    storeUrlFile = resolvePath(secretDirectory, "store-database-url");
    vaultUrlFile = resolvePath(secretDirectory, "vault-database-url");
    postgresPasswordFile = resolvePath(secretDirectory, "postgres-password");
    const postgresPassword = randomBytes(32).toString("base64url");
    prodLikeConfigFile = resolvePath(process.cwd(), "test/fixtures/prod-like-multi.yaml");
    await Promise.all([
      writeFile(masterKeyFile, masterKey, { encoding: "utf8", mode: 0o444 }),
      writeFile(storeUrlFile, `postgresql://harness:${postgresPassword}@postgres/harness`, {
        encoding: "utf8",
        mode: 0o444,
      }),
      writeFile(vaultUrlFile, `postgresql://harness:${postgresPassword}@postgres/harness_vault`, {
        encoding: "utf8",
        mode: 0o444,
      }),
      writeFile(postgresPasswordFile, postgresPassword, { encoding: "utf8", mode: 0o444 }),
    ]);
    compose(["up", "--detach", "--wait", "--wait-timeout", "450"], 460_000);
  }, 480_000);

  afterAll(async () => {
    if (secretDirectory !== "") {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("checks service health and resumes a run checkpointed during container stop", async () => {
    expect(inspect("harness", "{{.State.Health.Status}}")).toBe("healthy");
    expect(inspect("sandbox-runner", "{{.State.Health.Status}}")).toBe("healthy");

    const collectorAddress = serviceAddress("otel-collector", "internal");
    const healthChecks = [
      "const check = async (url, healthy, options) => {",
      "for (let retry = 0; retry < 20; retry += 1) {",
      "try { const response = await fetch(url, options); if (healthy(response)) return true; } catch {}",
      "await new Promise((resolve) => setTimeout(resolve, 250));",
      "}",
      "return false;",
      "};",
      "const controlPlaneToken = require('node:fs').readFileSync('/run/secrets/control_plane_token', 'utf8').trim();",
      "Promise.all([",
      "check('http://127.0.0.1:3000/mcp', (response) => response.status !== 401 && response.status !== 403 && response.status < 500, { headers: { authorization: 'Bearer ' + controlPlaneToken } }),",
      `check('http://${collectorAddress}:13133/', (response) => response.ok),`,
      "]).then((results) => {",
      "if (!results[0]) process.stdout.write('control_plane_unhealthy\\n');",
      "if (!results[1]) process.stdout.write('collector_unhealthy\\n');",
      "if (results.some((result) => !result)) process.exitCode = 1;",
      "})",
      ".catch(() => { process.exitCode = 1; });",
    ].join("");
    compose(["exec", "--no-TTY", "harness", "node", "-e", healthChecks]);

    const runContainer = `${projectName}-shutdown-run`;
    const shutdownRunScript = [
      'import { Command } from "commander";',
      'import { writeFileSync } from "node:fs";',
      'import { createDefaultContext, createOutput, main } from "@harness/cli/programmatic";',
      'import { FakeModelPort } from "@harness/core/testing";',
      'import { openConfiguredRunQueue } from "@harness/core";',
      "const action = process.env.HARNESS_E2E_ACTION;",
      "const context = createDefaultContext(new Command(), createOutput());",
      "const config = await context.loadConfig();",
      "const queue = await openConfiguredRunQueue(config, { clock: context.clock, secretResolver: context.secretResolver });",
      'const scriptedModel = new FakeModelPort([{ parts: [{ type: "text", text: "resumed" }], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop", provider: "scripted", model: "shutdown-test", latencyMs: 1, schemaValid: true, repairAttempts: 0, fallbackDepth: 0, providerBlobs: null }]);',
      "const createRuntime = context.createRuntime;",
      'context.createRuntime = async (config, overrides) => createRuntime(config, { ...overrides, queue, model: { complete: async (request, runContext) => { if (action === "run") { process.stdout.write(`RUN_STARTED ${runContext.runId}\\n`); await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 60000); runContext.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("synthetic slow model interrupted")); }, { once: true }); }); } return scriptedModel.complete(request, runContext); } } });',
      'const args = action === "run" ? (writeFileSync("/tmp/harness-shutdown-input.json", JSON.stringify({ goal: "resume after container stop" })), ["run", "--input", "/tmp/harness-shutdown-input.json"]) : ["--json", "resume", process.env.HARNESS_E2E_RUN_ID];',
      "process.exitCode = await main(args, context);",
      "await queue.close();",
    ].join("\n");
    compose([
      "run",
      "--detach",
      "--no-deps",
      "--name",
      runContainer,
      "--entrypoint",
      "node",
      "-e",
      "HARNESS_E2E_ACTION=run",
      "harness",
      "--input-type=module",
      "-e",
      shutdownRunScript,
    ]);

    const runId = await waitForRunStart(runContainer);
    const stopStarted = Date.now();
    execFileSync("docker", ["stop", "--time", "30", runContainer], {
      encoding: "utf8",
      timeout: 35_000,
    });
    expect(Date.now() - stopStarted).toBeLessThan(30_000);
    const suspended = parseJson(
      InspectResultSchema,
      compose(["run", "--rm", "--no-deps", "harness", "--json", "inspect", runId]),
    );
    expect(suspended.status).toBe("suspended");
    expect(suspended.lastCheckpoint).not.toBeNull();
    expect(suspended.events.map(({ type }) => type)).toContain("checkpoint_written");

    try {
      const resumedOutput = compose([
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "node",
        "-e",
        "HARNESS_E2E_ACTION=resume",
        "-e",
        `HARNESS_E2E_RUN_ID=${runId}`,
        "harness",
        "--input-type=module",
        "-e",
        shutdownRunScript,
      ]);
      expect(parseJson(RunResultSchema, resumedOutput).status).toBe("completed");
    } finally {
      execFileSync("docker", ["rm", "-f", runContainer], { encoding: "utf8" });
    }
  }, 300_000);
});

async function waitForRunStart(container: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const logs = execFileSync("docker", ["logs", container], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const match = /RUN_STARTED ([0-9A-Z]{26})/u.exec(logs);
    if (match?.[1] !== undefined) {
      return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The slow fake run did not start in time.");
}
