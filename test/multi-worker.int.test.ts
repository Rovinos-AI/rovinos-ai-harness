// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectName = `harness-multi-worker-${String(process.pid)}`;
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
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const runId = "00000000000000000000000001";
const rawCanary = `multi-worker-${String(process.pid)}@example.test`;
const firstWorkerContainer = `${projectName}-worker-1`;
const secondWorkerContainer = `${projectName}-worker-2`;
let scriptContainerSequence = 0;
let secretDirectory = "";
let runnerTokenFile = "";
let controlPlaneTokenFile = "";
let masterKeyFile = "";
let storeUrlFile = "";
let vaultUrlFile = "";
let postgresPasswordFile = "";
const workerContainers = [firstWorkerContainer, secondWorkerContainer];

function compose(args: readonly string[], timeout = 300_000): string {
  const environment = { ...composeEnvironment };
  delete environment.SANDBOX_RUNNER_TOKEN;
  environment.SANDBOX_RUNNER_TOKEN_SECRET_FILE = runnerTokenFile;
  environment.CONTROL_PLANE_TOKEN_SECRET_FILE = controlPlaneTokenFile;
  environment.HARNESS_MASTER_KEY_SECRET_FILE = masterKeyFile;
  environment.HARNESS_STORE_DATABASE_URL_SECRET_FILE = storeUrlFile;
  environment.HARNESS_VAULT_DATABASE_URL_SECRET_FILE = vaultUrlFile;
  environment.POSTGRES_PASSWORD_SECRET_FILE = postgresPasswordFile;
  return execFileSync("docker", [...composeArgs, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: environment,
    timeout,
  });
}

function runHarnessScript(
  script: string,
  options: { readonly name?: string; readonly detach?: boolean } = {},
): string {
  const containerName =
    options.name ?? `${projectName}-script-${String(process.pid)}-${String(++scriptContainerSequence)}`;
  const args = [
    "create",
    "--name",
    containerName,
    "--network",
    `${projectName}_internal`,
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
    `type=bind,source=${join(root, "test/fixtures/prod-like-multi.yaml")},target=/run/prod-like.yaml,readonly`,
    ...[
      ["sandbox_runner_token", runnerTokenFile],
      ["control_plane_token", controlPlaneTokenFile],
      ["harness_master_key", masterKeyFile],
      ["store_database_url", storeUrlFile],
      ["vault_database_url", vaultUrlFile],
      ["postgres_password", postgresPasswordFile],
    ].flatMap(([name, path]) => [
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
  execFileSync("docker", args, { encoding: "utf8" });
  execFileSync("docker", ["network", "connect", `${projectName}_sandbox`, containerName], {
    encoding: "utf8",
  });
  if (options.detach === true) {
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

function workerScript(mode: "block" | "complete"): string {
  return [
    'import { Pool } from "pg";',
    'import { readFileSync } from "node:fs";',
    'import { Command } from "commander";',
    'import { createDefaultContext, createOutput } from "@harness/cli/programmatic";',
    'import { Worker, createRuntime, openConfiguredRunQueue } from "@harness/core";',
    'import { allowAllPolicy } from "@harness/core/testing";',
    "const context = createDefaultContext(new Command(), createOutput());",
    "const config = await context.loadConfig();",
    "const queue = await openConfiguredRunQueue(config, { clock: context.clock, secretResolver: context.secretResolver });",
    "const sql = new Pool({ connectionString: readFileSync('/run/secrets/store_database_url', 'utf8').trim() });",
    "let modelCalls = 0;",
    "const completion = (parts, finishReason) => ({ provider: 'synthetic', model: 'multi-worker', parts, providerBlobs: null, usage: { inputTokens: 1, outputTokens: 1 }, finishReason, latencyMs: 0, schemaValid: true, repairAttempts: 0, fallbackDepth: 0 });",
    `const model = { complete: async (_request, runContext) => { modelCalls += 1; if (${JSON.stringify(mode)} === 'block' && modelCalls === 1) return completion([{ type: 'tool_call', callId: '00000000000000000000000002', toolId: 'test.multi_worker', args: { email: ${JSON.stringify(rawCanary)} } }], 'tool_calls'); if (${JSON.stringify(mode)} === 'block' && modelCalls === 2) { const events = []; for await (const event of runtime.store.read(runContext.runId)) events.push(event); if (!events.some((event) => event.type === 'tool_result' && event.toolId === 'test.multi_worker')) throw new Error('multi_worker_tool_result_not_durable'); process.stdout.write('WORKER_TOOL_RESULT_DURABLE\\n'); process.stdout.write('WORKER_BLOCKED ' + runContext.runId + '\\n'); return new Promise(() => undefined); } return completion([{ type: 'text', text: 'finished' }], 'stop'); } };`,
    "const tool = { describe: () => ({ idempotent: false, timeoutMs: 10000 }), execute: async (_call, runContext) => { await sql.query('INSERT INTO multi_worker_side_effects (run_id, executions) VALUES ($1, 1) ON CONFLICT (run_id) DO UPDATE SET executions = multi_worker_side_effects.executions + 1', [runContext.runId]); return { outcome: 'ok', result: { ok: true } }; } };",
    "const runtime = await createRuntime(config, { queue, clock: context.clock, secretResolver: context.secretResolver, policy: allowAllPolicy, model, tool });",
    "const worker = new Worker({ queue, ids: runtime.ids, clock: runtime.clock, leaseMs: 3000, pollIntervalMs: 100, execute: async (job, signal) => { const result = await runtime.resume(job.runId, { signal }); process.stdout.write('WORKER_RESULT ' + result.status + '\\n'); return result; } });",
    "process.once('SIGTERM', () => worker.stop());",
    "process.once('SIGINT', () => worker.stop());",
    "await worker.run();",
    "await runtime.close();",
    "await queue.close();",
    "await sql.end();",
  ].join("\n");
}

function verificationScript(): string {
  return [
    'import { Command } from "commander";',
    'import { createDefaultContext, createOutput } from "@harness/cli/programmatic";',
    'import { createRuntime, openConfiguredRunQueue } from "@harness/core";',
    'import { allowAllPolicy } from "@harness/core/testing";',
    "const context = createDefaultContext(new Command(), createOutput());",
    "const config = await context.loadConfig();",
    "const queue = await openConfiguredRunQueue(config, { clock: context.clock, secretResolver: context.secretResolver });",
    "const runtime = await createRuntime(config, { queue, clock: context.clock, secretResolver: context.secretResolver, policy: allowAllPolicy });",
    `const runId = ${JSON.stringify(runId)};`,
    "const events = [];",
    "for await (const event of runtime.store.read(runId)) events.push(event);",
    `const raw = ${JSON.stringify(rawCanary)};`,
    "if (JSON.stringify(events).includes(raw)) throw new Error('multi_worker_raw_value_persisted');",
    "const intent = events.find((event) => event.type === 'tool_intent' && event.toolId === 'test.multi_worker');",
    "if (intent === undefined || intent.args === null || typeof intent.args !== 'object' || Array.isArray(intent.args) || typeof intent.args.email !== 'string') throw new Error('multi_worker_token_missing');",
    "const resolved = await runtime.vault.resolve(runId, intent.args.email, { boundary: 'ui' });",
    "if (resolved !== raw) throw new Error('multi_worker_vault_mismatch');",
    "process.stdout.write('MULTI_WORKER_VERIFY_OK\\n');",
    "await runtime.close();",
    "await queue.close();",
  ].join("\n");
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("multi_worker_container_timeout");
}

describe.skipIf(!dockerAvailable)("multi-worker deployment", () => {
  beforeAll(async () => {
    const mountableTemp = join(root, ".tmp");
    await mkdir(mountableTemp, { recursive: true });
    secretDirectory = await mkdtemp(join(mountableTemp, "harness-multi-worker-"));
    runnerTokenFile = join(secretDirectory, "sandbox_runner_token");
    controlPlaneTokenFile = join(secretDirectory, "control_plane_token");
    masterKeyFile = join(secretDirectory, "harness_master_key");
    storeUrlFile = join(secretDirectory, "store_database_url");
    vaultUrlFile = join(secretDirectory, "vault_database_url");
    postgresPasswordFile = join(secretDirectory, "postgres_password");
    const runnerToken = randomBytes(32).toString("base64url");
    const postgresPassword = randomBytes(32).toString("base64url");
    await Promise.all([
      writeFile(runnerTokenFile, runnerToken, { mode: 0o444 }),
      writeFile(controlPlaneTokenFile, randomBytes(32).toString("base64url"), { mode: 0o444 }),
      writeFile(masterKeyFile, randomBytes(32).toString("base64"), { mode: 0o444 }),
      writeFile(postgresPasswordFile, postgresPassword, { mode: 0o444 }),
      writeFile(storeUrlFile, `postgresql://harness:${postgresPassword}@postgres/harness`, {
        mode: 0o444,
      }),
      writeFile(vaultUrlFile, `postgresql://harness:${postgresPassword}@postgres/harness_vault`, {
        mode: 0o444,
      }),
    ]);
    compose(
      [
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "450",
        "postgres",
        "sandbox-runner",
        "sandbox-runner-2",
      ],
      460_000,
    );
  }, 480_000);

  afterAll(async () => {
    for (const container of workerContainers) {
      try {
        execFileSync("docker", ["rm", "-f", container], { encoding: "utf8" });
      } catch {
        // Cleanup is best-effort after a failed startup or assertion.
      }
    }
    try {
      compose(["down", "--volumes", "--remove-orphans"], 120_000);
    } catch {
      // Cleanup is best-effort after a failed startup or assertion.
    }
    if (secretDirectory !== "") {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  }, 150_000);

  it("reclaims a killed worker's job without repeating a non-idempotent side effect", async () => {
    compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "harness",
      "-d",
      "harness",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "CREATE TABLE multi_worker_side_effects (run_id text PRIMARY KEY, executions integer NOT NULL)",
    ]);

    const seedScript = [
      'import { readFileSync } from "node:fs";',
      'import { Pool } from "pg";',
      'import { Id } from "@harness/schemas";',
      'import { PostgresEventStore, PostgresRunQueue } from "@harness/store-postgres";',
      `const runId = Id.parse(${JSON.stringify(runId)});`,
      "const storeUrl = readFileSync('/run/secrets/store_database_url', 'utf8').trim();",
      "const connection = new Pool({ connectionString: storeUrl });",
      "await connection.query('SELECT 1');",
      "await connection.end();",
      "const store = new PostgresEventStore(storeUrl);",
      "const queue = new PostgresRunQueue(storeUrl);",
      "const envelope = { runId, ts: Date.now(), v: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), segmentId: runId };",
      "await store.append(runId, [{ ...envelope, type: 'run_created', configHash: 'c'.repeat(64), policyVersion: 'test.policy', depth: 0 }, { ...envelope, ts: Date.now() + 1, type: 'run_input', input: { goal: 'execute one synthetic side effect' }, inputKind: 'initial' }], 0);",
      "await queue.enqueue({ kind: 'start', runId });",
      "await store.close();",
      "await queue.close();",
      "process.stdout.write('MULTI_RUN_SEEDED\\n');",
    ].join("\n");
    runHarnessScript(seedScript);

    runHarnessScript(workerScript("block"), { name: firstWorkerContainer, detach: true });
    await waitForLog(firstWorkerContainer, `WORKER_BLOCKED ${runId}`);

    runHarnessScript(workerScript("complete"), { name: secondWorkerContainer, detach: true });
    execFileSync("docker", ["kill", firstWorkerContainer], { encoding: "utf8" });
    const logs = await waitForLog(secondWorkerContainer, `WORKER_RESULT completed`, 90_000);
    expect(logs).toContain(`WORKER_RESULT completed`);

    const sideEffects = compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "harness",
      "-d",
      "harness",
      "-Atc",
      `SELECT executions FROM multi_worker_side_effects WHERE run_id = '${runId}'`,
    ]).trim();
    expect(sideEffects).toBe("1");

    const verification = runHarnessScript(verificationScript());
    expect(verification).toContain("MULTI_WORKER_VERIFY_OK");
    execFileSync("docker", ["stop", "--time", "5", secondWorkerContainer], {
      encoding: "utf8",
    });
  }, 300_000);
});
