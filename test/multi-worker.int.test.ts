// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMultiWorkerCompose } from "../scripts/compose/multi-worker.js";

const projectName = `harness-multi-worker-${String(process.pid)}`;
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const runId = "00000000000000000000000001";
const rawCanary = `multi-worker-${String(process.pid)}@example.test`;
const firstWorkerContainer = `${projectName}-worker-1`;
const secondWorkerContainer = `${projectName}-worker-2`;
let secretDirectory = "";
let runnerTokenFile = "";
let controlPlaneTokenFile = "";
let masterKeyFile = "";
let storeUrlFile = "";
let vaultUrlFile = "";
let postgresPasswordFile = "";
let blockWorkerEnvironmentFile = "";
let completeWorkerEnvironmentFile = "";
let verificationEnvironmentFile = "";
const workerContainers = [firstWorkerContainer, secondWorkerContainer];
const secretFiles = {
  runnerToken: runnerTokenFile,
  controlPlaneToken: controlPlaneTokenFile,
  masterKey: masterKeyFile,
  storeUrl: storeUrlFile,
  vaultUrl: vaultUrlFile,
  postgresPassword: postgresPasswordFile,
};
const docker = createMultiWorkerCompose({ projectName, root, secretFiles });

function workerScript(): string {
  return [
    'import { Pool } from "pg";',
    'import { readFileSync } from "node:fs";',
    'import { Command } from "commander";',
    'import { createDefaultContext, createOutput } from "@rovinos/cli/programmatic";',
    'import { Worker, createRuntime, openConfiguredRunQueue } from "@rovinos/core";',
    'import { allowAllPolicy } from "@rovinos/core/testing";',
    "const context = createDefaultContext(new Command(), createOutput());",
    "const config = await context.loadConfig();",
    "const queue = await openConfiguredRunQueue(config, { clock: context.clock, secretResolver: context.secretResolver });",
    "const sql = new Pool({ connectionString: readFileSync('/run/secrets/store_database_url', 'utf8').trim() });",
    "const mode = process.env.MULTI_WORKER_MODE;",
    "const rawCanary = process.env.MULTI_WORKER_RAW_CANARY;",
    "if ((mode !== 'block' && mode !== 'complete') || rawCanary === undefined) throw new Error('multi_worker_environment_invalid');",
    "let modelCalls = 0;",
    "const completion = (parts, finishReason) => ({ provider: 'synthetic', model: 'multi-worker', parts, providerBlobs: null, usage: { inputTokens: 1, outputTokens: 1 }, finishReason, latencyMs: 0, schemaValid: true, repairAttempts: 0, fallbackDepth: 0 });",
    "const model = { complete: async (_request, runContext) => { modelCalls += 1; if (mode === 'block' && modelCalls === 1) return completion([{ type: 'tool_call', callId: '00000000000000000000000002', toolId: 'test.multi_worker', args: { email: rawCanary } }], 'tool_calls'); if (mode === 'block' && modelCalls === 2) { const events = []; for await (const event of runtime.store.read(runContext.runId)) events.push(event); if (!events.some((event) => event.type === 'tool_result' && event.toolId === 'test.multi_worker')) throw new Error('multi_worker_tool_result_not_durable'); process.stdout.write('WORKER_TOOL_RESULT_DURABLE\\n'); process.stdout.write('WORKER_BLOCKED ' + runContext.runId + '\\n'); return new Promise(() => undefined); } return completion([{ type: 'text', text: 'finished' }], 'stop'); } };",
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
    'import { createDefaultContext, createOutput } from "@rovinos/cli/programmatic";',
    'import { createRuntime, openConfiguredRunQueue } from "@rovinos/core";',
    'import { allowAllPolicy } from "@rovinos/core/testing";',
    "const context = createDefaultContext(new Command(), createOutput());",
    "const config = await context.loadConfig();",
    "const queue = await openConfiguredRunQueue(config, { clock: context.clock, secretResolver: context.secretResolver });",
    "const runtime = await createRuntime(config, { queue, clock: context.clock, secretResolver: context.secretResolver, policy: allowAllPolicy });",
    `const runId = ${JSON.stringify(runId)};`,
    "const events = [];",
    "for await (const event of runtime.store.read(runId)) events.push(event);",
    "const raw = process.env.MULTI_WORKER_RAW_CANARY;",
    "if (raw === undefined) throw new Error('multi_worker_environment_invalid');",
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

describe.skipIf(!docker.available)("multi-worker deployment", () => {
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
    blockWorkerEnvironmentFile = join(secretDirectory, "worker-block.env");
    completeWorkerEnvironmentFile = join(secretDirectory, "worker-complete.env");
    verificationEnvironmentFile = join(secretDirectory, "verification.env");
    secretFiles.runnerToken = runnerTokenFile;
    secretFiles.controlPlaneToken = controlPlaneTokenFile;
    secretFiles.masterKey = masterKeyFile;
    secretFiles.storeUrl = storeUrlFile;
    secretFiles.vaultUrl = vaultUrlFile;
    secretFiles.postgresPassword = postgresPasswordFile;
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
      writeFile(
        blockWorkerEnvironmentFile,
        `MULTI_WORKER_MODE=block\nMULTI_WORKER_RAW_CANARY=${rawCanary}\n`,
        { mode: 0o444 },
      ),
      writeFile(
        completeWorkerEnvironmentFile,
        `MULTI_WORKER_MODE=complete\nMULTI_WORKER_RAW_CANARY=${rawCanary}\n`,
        { mode: 0o444 },
      ),
      writeFile(verificationEnvironmentFile, `MULTI_WORKER_RAW_CANARY=${rawCanary}\n`, {
        mode: 0o444,
      }),
    ]);
    docker.compose(
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
        docker.removeContainer(container);
      } catch {
        // Cleanup is best-effort after a failed startup or assertion.
      }
    }
    try {
      docker.compose(["down", "--volumes", "--remove-orphans"], 120_000);
    } catch {
      // Cleanup is best-effort after a failed startup or assertion.
    }
    if (secretDirectory !== "") {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  }, 150_000);

  it("reclaims a killed worker's job without repeating a non-idempotent side effect", async () => {
    docker.compose([
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
      'import { Id } from "@rovinos/schemas";',
      'import { PostgresEventStore, PostgresRunQueue } from "@rovinos/store-postgres";',
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
    docker.runHarnessScript(seedScript);

    docker.runHarnessScript(workerScript(), {
      name: firstWorkerContainer,
      detach: true,
      envFile: blockWorkerEnvironmentFile,
    });
    await docker.waitForLog(firstWorkerContainer, `WORKER_BLOCKED ${runId}`);

    docker.runHarnessScript(workerScript(), {
      name: secondWorkerContainer,
      detach: true,
      envFile: completeWorkerEnvironmentFile,
    });
    docker.killContainer(firstWorkerContainer);
    const logs = await docker.waitForLog(secondWorkerContainer, `WORKER_RESULT completed`, 90_000);
    expect(logs).toContain(`WORKER_RESULT completed`);

    const sideEffects = docker
      .compose([
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
      ])
      .trim();
    expect(sideEffects).toBe("1");

    const verification = docker.runHarnessScript(verificationScript(), {
      envFile: verificationEnvironmentFile,
    });
    expect(verification).toContain("MULTI_WORKER_VERIFY_OK");
    docker.stopContainer(secondWorkerContainer);
  }, 300_000);
});
