// SPDX-License-Identifier: Apache-2.0
// Every task that wires a capability into the runtime or CLI extends this test.
// Not wired yet: human input contracts into runtime input handling (25.1 -> #239)
// Not wired yet: MCP input_required to the human input broker (25.3 -> #241)
// Not wired yet: control-plane consumer of store watch/watchRuns (24.5 -> #234)
// Not wired yet: gateway token progress to live run updates (14.16 -> #157; 24.5 -> #234)
// Not wired yet: Vertex AI provider registration in runtime configuration (14.20 -> #161)
// Not wired yet: SDK answerInput (epic 25, human input broker 25.3 -> #241)
// Not wired yet: automatic resume after a durable human-input answer (25.5 -> #243)
// Not wired yet: filesystem-backed offload workspace selection per run (19.5 -> #96)
// Not wired yet: Bedrock adapter registration in the runtime provider factory (14.19 -> #160)
// Not wired yet: user pseudonym emission in runtime telemetry (12.8 -> #139)
// Not wired yet: simulated eval approver identity (16.6 -> #172)
// Not wired yet: eval runner orchestration in the shipped CLI (16.2 -> #168)
// Not wired yet: worker claim-time concurrency quota enforcement (24.3 -> #232)
// Not wired yet: CLI integration for replayRun (9.3 package API -> #154)
import { Command } from "commander";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { ExportResultCode } from "@opentelemetry/core";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createDefaultContext,
  createControlPlaneOperations,
  createOutput,
  ExitCode,
  main,
  type CliContext,
} from "@rovinos/cli/programmatic";
import {
  createControlPlaneServer,
  startControlPlaneHttp,
  startRunOutputSchema,
} from "@rovinos/control-plane";
import { createHarness } from "@rovinos/sdk";
import {
  CompositeSecretResolver,
  EnvSecretResolver,
  FileSecretResolver,
  loadConfig,
  HarnessConfigSchema,
} from "@rovinos/config";
import {
  Checkpointer,
  createRuntime,
  foldRunState,
  NaiveContext,
  openConfiguredRunQueue,
  requestApproval,
  RunRecorder,
  RUN_SPAN,
  Worker,
  type ModelPort,
  type ModelCompletion,
  type PolicyPort,
  type ToolPort,
} from "@rovinos/core";
import { FakeModelPort } from "@rovinos/core/testing";
import {
  ExecSpecSchema,
  FsOperationRequestSchema,
  FsToolResultSchema,
  RemoteSandboxBackend,
  WebFetchRequestSchema,
  WebFetchResultSchema,
  SandboxExecTool,
  type SandboxBackend,
} from "@rovinos/sandbox";
import { InMemoryEventStore, type EventStore } from "@rovinos/store";
import { createEventBuilders } from "@rovinos/store/testing";
import { createPolicyCheckedAppCallHandler } from "@rovinos/host";
import { SqliteEventStore } from "@rovinos/store-sqlite";
import { ProviderError, type ProviderAdapter } from "@rovinos/models";
import { FakeProvider } from "@rovinos/models/testing";
import { ReplayReportSchema } from "@rovinos/replay";
import { ApprovalNotificationSchema, buildApprovalPayload } from "@rovinos/policy";
import {
  ApprovalListResultSchema,
  ApprovalShowResultSchema,
  ApprovalSweepResultSchema,
  Code,
  ControlPlaneConfigSchema,
  FakeClock,
  Id,
  JsonValue,
  KeysConfigSchema,
  ModelsConfigSchema,
  PiiConfigSchema,
  RunConfigSchema,
  RunResultSchema,
  SandboxConfigSchema,
  ServersConfigSchema,
  SequentialIdGenerator,
  SecretRefSchema,
  type Event,
  type ModelRequest,
  StoreMigrateResultSchema,
  StorePurgeResultSchema,
  parseJson,
} from "@rovinos/schemas";
import {
  AkvKeyProvider,
  AkvSecretResolver,
  LocalKeyProvider,
  SqliteVault,
  Token,
} from "@rovinos/vault";
import {
  attr,
  createTelemetrySdk,
  defineLogRecord,
  defineSpan,
  listLogDefinitions,
  listSpanDefinitions,
  SentinelGate,
  toSafeEvent,
  type TelemetrySdkOptions,
  VaultRunView,
  withSpan,
} from "@rovinos/telemetry";
import { z } from "zod";
import { createSandboxComposeInvocation } from "../scripts/compose/sandbox.js";
import { runNetworkIsolationCompose } from "../scripts/ci/network-isolation.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DAY_MS = 86_400_000;
const KEY_REF = "env:HARNESS_E2E_KEY";
const KEY_ID = "e2e-test";
const ALLOW_TOOL = "update_plan";
const ASK_TOOL = "synthetic.ask";
// Synthetic CLI/SDK fixtures never execute commands; their egress config only
// exercises Compose rendering. The remote roundtrip below uses the real factory.
const unusedSandboxBackend: SandboxBackend = {
  exec: () => Promise.reject(new Error("The synthetic tool port does not execute commands.")),
};
const MCP_ERROR_CANARY = "MCP_SERVER_ERROR_CANARY";
const logDefinition = defineLogRecord("harness.e2e.skeleton", {
  "harness.error.code": attr.code(),
});
type ExportedSpan = Parameters<TelemetrySdkOptions["spanExporter"]["export"]>[0][number];
type ExportedLogRecord = Parameters<TelemetrySdkOptions["logExporter"]["export"]>[0][number];

interface CliCapture {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

interface Skeleton {
  readonly directory: string;
  readonly configPath: string;
  readonly dataDirectory: string;
  readonly eventStorePath: string;
  readonly canary: string;
  readonly clock: FakeClock;
  readonly ids: SequentialIdGenerator;
  readonly model: FakeModelPort;
  readonly callsBeforeApproval: string[];
  readonly callsAfterApproval: string[];
  readonly argsAfterApproval: JsonValue[];
  readonly sentinelProbe: { enabled: boolean };
  readonly stdout: string[];
  readonly stderr: string[];
  readonly approvalOutput: string[];
  readonly context: CliContext;
  readonly spans: ExportedSpan[];
  readonly logs: ExportedLogRecord[];
  readonly telemetry: ReturnType<typeof createTelemetrySdk>;
  runId?: Id;
  approvalId?: Id;
  eventStoreBytes?: Uint8Array;
  snapshotBytes?: Uint8Array;
  toolCallEvents?: readonly Event[];
}

let skeleton: Skeleton | undefined;
let previousConfig: string | undefined;
let previousDataDirectory: string | undefined;
let previousKey: string | undefined;

function fixture(): Skeleton {
  if (skeleton === undefined) {
    throw new Error("The end-to-end fixture has not been initialized.");
  }
  return skeleton;
}

function completion(
  calls: readonly { readonly callId: string; readonly toolId: string; readonly args: JsonValue }[],
  content: string,
): ModelCompletion {
  return {
    provider: "synthetic",
    model: "synthetic",
    parts: [
      { type: "text", text: content },
      ...calls.map((call) => ({ type: "tool_call" as const, ...call })),
    ],
    providerBlobs: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: calls.length === 0 ? "stop" : "tool_calls",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
  };
}

function syntheticTools(
  callsBeforeApproval: string[],
  callsAfterApproval: string[],
  argsAfterApproval: JsonValue[],
): ToolPort {
  return {
    describe: (toolId) =>
      toolId === ALLOW_TOOL || toolId === ASK_TOOL
        ? { idempotent: true, timeoutMs: 1_000 }
        : undefined,
    execute: (call) => {
      if (call.toolId === ALLOW_TOOL) {
        callsBeforeApproval.push(call.toolId);
      } else if (call.toolId === ASK_TOOL) {
        callsAfterApproval.push(call.toolId);
        argsAfterApproval.push(call.args);
      }
      const result =
        call.toolId === ASK_TOOL &&
        call.args !== null &&
        typeof call.args === "object" &&
        !Array.isArray(call.args) &&
        typeof call.args.email === "string"
          ? { ok: true, email: call.args.email }
          : { ok: true };
      return Promise.resolve({ outcome: "ok", result });
    },
  };
}

async function readEvents(store: EventStore, runId: Id) {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function invokeCli(args: readonly string[], captureOutput = true): Promise<CliCapture> {
  const current = fixture();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = createOutput({
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  const program = new Command();
  program.option("-c, --config <path>", "path to harness configuration");
  program.setOptionValue("config", current.configPath);
  const cliContext = createDefaultContext(program, out);
  cliContext.clock = current.clock;
  cliContext.createRuntime = (config, overrides) => {
    return createRuntime(config, {
      ...overrides,
      clock: current.clock,
      ids: current.ids,
      model: overrides?.model ?? current.model,
      roleConfigDirectory: current.directory,
      secretResolver: overrides?.secretResolver ?? new CompositeSecretResolver(),
      sandboxBackend: unusedSandboxBackend,
      tool: syntheticTools(
        current.callsBeforeApproval,
        current.callsAfterApproval,
        current.argsAfterApproval,
      ),
    });
  };
  const code = await main(args, cliContext);
  if (captureOutput) {
    current.stdout.push(...stdout);
    current.stderr.push(...stderr);
  }
  return { code, stdout, stderr };
}

async function invokeMcpCli(
  configPath: string,
  dataDirectory: string,
  model: FakeModelPort,
  createTransport: () => Promise<Transport>,
  args: readonly string[],
): Promise<CliCapture> {
  const current = fixture();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = createOutput({
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  const program = new Command();
  program.option("-c, --config <path>", "path to harness configuration");
  program.setOptionValue("config", configPath);
  const cliContext = createDefaultContext(program, out);
  cliContext.loadConfig = () => loadConfig({ configPath });
  cliContext.createRuntime = (config, overrides) => {
    return createRuntime(config, {
      ...overrides,
      dataDir: dataDirectory,
      clock: current.clock,
      ids: current.ids,
      model,
      roleConfigDirectory: dirname(configPath),
      secretResolver: overrides?.secretResolver ?? new CompositeSecretResolver(),
      mcpTransportFactory: createTransport,
    });
  };
  const code = await main(args, cliContext);
  return { code, stdout, stderr };
}

function jsonResult<Schema extends z.ZodType>(
  schema: Schema,
  output: readonly string[],
): z.infer<Schema> {
  return parseJson(schema, output.join("").trim());
}

function headerValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : null;
  }
  return null;
}

function expectCanaryOnlyInRevealed(result: CliCapture, canary: string): void {
  const displayed = jsonResult(ApprovalShowResultSchema, result.stdout);
  expect(result.stdout.join("")).toContain(canary);
  expect(JSON.stringify(displayed.revealed ?? null)).toContain(canary);
  expect(JSON.stringify({ ...displayed, revealed: undefined })).not.toContain(canary);
  expect(result.stderr.join("")).not.toContain(canary);
}

async function seedChildApproval(current: Skeleton, rootRunId: Id) {
  const childRunId = Id.parse(current.ids.next());
  const segmentId = Id.parse(current.ids.next());
  const parentCallId = Id.parse(current.ids.next());
  const callId = Id.parse(current.ids.next());
  const approvalId = Id.parse(current.ids.next());
  const args = { email: "<EMAIL_1>", foreign: "<PHONE_1>" };
  const store = new SqliteEventStore(current.eventStorePath);
  const recorder = new RunRecorder(store, childRunId, segmentId, 0, current.clock);
  try {
    await recorder.withStepSpan(RUN_SPAN, {}, async () => {
      const recorded = await recorder.recordBatch([
        {
          type: "run_created",
          v: 1,
          configHash: "a".repeat(64),
          policyVersion: "e2e.synthetic",
          parentRunId: rootRunId,
          parentCallId,
          scopeId: rootRunId,
          depth: 1,
        },
        {
          type: "run_status_changed",
          v: 1,
          from: "pending",
          to: "running",
          reason: "start",
        },
        {
          type: "tool_intent",
          v: 1,
          callId,
          toolId: ASK_TOOL,
          idempotent: true,
          policyDecision: "ask",
          argsHash: "b".repeat(64),
          args,
        },
      ]);
      const last = recorded.at(-1);
      if (last === undefined) {
        throw new Error("The synthetic child run was not recorded.");
      }
      return last;
    });
    const events = await readEvents(store, childRunId);
    const payload = buildApprovalPayload({
      call: { callId, toolId: ASK_TOOL, args },
      rule: { id: "ask_synthetic", reason: "synthetic_approval" },
      now: current.clock.now(),
    });
    await requestApproval(recorder, {
      approvalId,
      callId,
      payload: JsonValue.parse(payload),
      state: foldRunState(events),
      checkpointer: new Checkpointer({
        recorder,
        runId: childRunId,
        context: new NaiveContext(),
        ids: current.ids,
        clock: current.clock,
      }),
    });
  } finally {
    await store.close();
  }
  return { childRunId, approvalId };
}

beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-e2e-skeleton-"));
  const configPath = join(directory, "harness.yaml");
  const dataDirectory = join(directory, "data");
  const eventStorePath = join(dataDirectory, "harness.db");
  const canary = `canary.${directory.split("/").at(-1) ?? "fixture"}@example.test`;
  const key = Buffer.alloc(32, 29).toString("base64");
  previousConfig = process.env.HARNESS_CONFIG;
  previousDataDirectory = process.env.HARNESS_DATA_DIR;
  previousKey = process.env.HARNESS_E2E_KEY;
  process.env.HARNESS_CONFIG = configPath;
  process.env.HARNESS_DATA_DIR = dataDirectory;
  process.env.HARNESS_E2E_KEY = key;
  const spans: ExportedSpan[] = [];
  const records: ExportedLogRecord[] = [];
  let canaryAvailable = false;
  let probePending = false;
  const sentinelProbe = { enabled: false };
  let releaseProbeScan: () => void = () => undefined;
  const probeScanReady = new Promise<void>((resolve) => {
    releaseProbeScan = resolve;
  });
  const canaryProbeSpan = defineSpan(
    "harness.e2e.sentinel_probe",
    {
      "harness.run.id": attr.id(),
      "harness.e2e.canary": attr.enum([canary]),
    },
    { taskId: "8.4", packageName: "@rovinos/telemetry" },
  );
  const spanExporter: TelemetrySdkOptions["spanExporter"] = {
    export: (finished, callback) => {
      spans.push(...finished);
      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: () => Promise.resolve(),
  };
  const logExporter: TelemetrySdkOptions["logExporter"] = {
    export: (finished, callback) => {
      records.push(...finished);
      callback({ code: ExportResultCode.SUCCESS });
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
  const telemetry = createTelemetrySdk({
    spanExporter,
    logExporter,
    gate: new SentinelGate(
      new VaultRunView({
        listRawValueEntries: async () => {
          if (canaryAvailable) {
            await probeScanReady;
            return [{ rawValue: canary, entityType: Code.parse("email") }];
          }
          return [];
        },
        version: () => Promise.resolve(canaryAvailable ? 1 : 0),
      }),
      undefined,
      // Test budgets (see test/canary/telemetry.ts, #555).
      { maxPrepareMs: 1_000, maxScanMs: 1_000 },
    ),
    telemetry: {
      sentinel: { minValueLength: 6, enabled: true },
      correlation: { enabled: false },
    },
  });
  const forceFlush = telemetry.tracerProvider.forceFlush.bind(telemetry.tracerProvider);
  vi.spyOn(telemetry.tracerProvider, "forceFlush").mockImplementation(async () => {
    if (probePending) {
      probePending = false;
      releaseProbeScan();
    }
    await forceFlush();
  });
  if (!trace.setGlobalTracerProvider(telemetry.tracerProvider)) {
    throw new Error("The end-to-end tracer provider could not be registered.");
  }
  logs.setGlobalLoggerProvider(telemetry.loggerProvider);
  if (logs.getLoggerProvider() !== telemetry.loggerProvider) {
    throw new Error("The end-to-end logger provider could not be registered.");
  }
  const logger = logs.getLogger("@rovinos/telemetry");
  logger.emit({
    eventName: logDefinition.name,
    severityNumber: SeverityNumber.INFO,
    attributes: { "harness.error.code": "e2e_synthetic" },
  });

  const id = (value: number) => Id.parse(String(value).padStart(26, "0"));
  const model = new FakeModelPort([
    completion(
      [
        {
          callId: id(10),
          toolId: ALLOW_TOOL,
          args: { plan: { items: [], notes: canary } },
        },
        {
          callId: id(11),
          toolId: ASK_TOOL,
          args: { email: canary, foreign: "<PHONE_1>" },
        },
      ],
      "awaiting approval",
    ),
    completion([], "completed"),
  ]);
  const complete = model.complete.bind(model);
  model.complete = async (request, context) => {
    const response = await complete(request, context);
    if (response.finishReason === "stop" && sentinelProbe.enabled) {
      canaryAvailable = true;
      probePending = true;
      await withSpan(
        canaryProbeSpan,
        { "harness.run.id": context.runId, "harness.e2e.canary": canary },
        () => undefined,
      );
    }
    return response;
  };
  const clock = new FakeClock(1_000);
  const ids = new SequentialIdGenerator();
  const callsBeforeApproval: string[] = [];
  const callsAfterApproval: string[] = [];
  const argsAfterApproval: JsonValue[] = [];
  await writeFile(
    configPath,
    [
      "run:",
      "  checkpointEveryEvents: 2",
      "keys:",
      `  currentKeyId: ${KEY_ID}`,
      "  keys:",
      `    - id: ${KEY_ID}`,
      `      secret: ${KEY_REF}`,
      "policy:",
      "  file: policy.yaml",
      "pii:",
      "  defaultAction: tokenize",
      "  detokenize:",
      `    - toolId: ${ASK_TOOL}`,
      "      args:",
      "        - /email",
      "store:",
      "  retention:",
      "    completedRunsDays: 1",
      "    failedRunsDays: 1",
      "telemetry:",
      "  sentinel:",
      "    enabled: false",
      "sandbox:",
      "  egress:",
      "    allow:",
      "      - host: e2e-egress.example.test",
      "        ports: [443]",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(directory, "policy.yaml"),
    [
      "version: 1",
      "defaultDecision: deny",
      "rules:",
      `  - id: allow_synthetic`,
      "    match:",
      `      tools: [${ALLOW_TOOL}]`,
      "    decision: allow",
      "    reason: synthetic_allowed",
      `  - id: ask_synthetic`,
      "    match:",
      `      tools: [${ASK_TOOL}]`,
      "    decision: ask",
      "    reason: synthetic_approval",
      "    escalateAfterMs: 1",
      "",
    ].join("\n"),
    "utf8",
  );
  const initialInput = join(directory, "input.json");
  await writeFile(initialInput, JSON.stringify({ goal: `Process ${canary}` }), "utf8");
  skeleton = {
    directory,
    configPath,
    dataDirectory,
    eventStorePath,
    canary,
    clock,
    ids,
    model,
    callsBeforeApproval,
    callsAfterApproval,
    argsAfterApproval,
    sentinelProbe,
    stdout: [],
    stderr: [],
    approvalOutput: [],
    context: createDefaultContext(new Command(), createOutput()),
    spans,
    logs: records,
    telemetry,
  };
});

afterAll(async () => {
  const current = skeleton;
  if (current !== undefined) {
    await current.telemetry.tracerProvider.shutdown();
    await current.telemetry.loggerProvider.shutdown();
    await rm(current.directory, { recursive: true, force: true });
  }
  if (previousConfig === undefined) {
    delete process.env.HARNESS_CONFIG;
  } else {
    process.env.HARNESS_CONFIG = previousConfig;
  }
  if (previousDataDirectory === undefined) {
    delete process.env.HARNESS_DATA_DIR;
  } else {
    process.env.HARNESS_DATA_DIR = previousDataDirectory;
  }
  if (previousKey === undefined) {
    delete process.env.HARNESS_E2E_KEY;
  } else {
    process.env.HARNESS_E2E_KEY = previousKey;
  }
});

describe("config", () => {
  it("loads policy, SQLite, local-key, PII, retention, and telemetry config from the default CLI context", async () => {
    const current = fixture();
    const loaded = await current.context.loadConfig();
    expect(loaded.policy.file).toBe("policy.yaml");
    expect(loaded.keys?.currentKeyId).toBe(KEY_ID);
    expect(loaded.pii.defaultAction).toBe("tokenize");
    expect(loaded.vault).toEqual({ backend: "sqlite", purgeAfterDays: 7 });
    expect(loaded.store.retention).toEqual({ completedRunsDays: 1, failedRunsDays: 1 });
    expect(await readFile(current.configPath, "utf8")).not.toContain(current.canary);
  });

  it("refuses multi-instance runtime startup with local SQLite adapters", async () => {
    const current = fixture();
    const loaded = await current.context.loadConfig();
    const multi = HarnessConfigSchema.parse({ ...loaded, deployment: { mode: "multi" } });

    await expect(createRuntime(multi)).rejects.toMatchObject({
      code: "deployment_requires_postgres",
    });
  });

  it("loads a configured Azure Key Vault key through the injected resolver", async () => {
    const keyBytes = Buffer.alloc(32, 37);
    const provider = new AkvKeyProvider({
      config: KeysConfigSchema.parse({
        currentKeyId: "e2e-test",
        keys: [{ id: "e2e-test", secret: "akv:vault-name/harness-key-e2e-test" }],
      }),
      vaultName: "vault-name",
      secretResolver: new AkvSecretResolver({
        clientFactory: () => ({
          getSecret: () => Promise.resolve({ value: keyBytes.toString("base64") }),
        }),
      }),
    });

    try {
      expect(await provider.getKey(provider.currentKeyId())).toEqual(new Uint8Array(keyBytes));
    } finally {
      provider.dispose();
    }
  });

  it("maps sandbox egress config to the optional Compose overlay", async () => {
    const current = fixture();
    const config = await loadConfig({ configPath: current.configPath });
    const allow = [{ host: "e2e-egress.example.test", ports: [443] }];
    const invocation = createSandboxComposeInvocation(config.sandbox.egress, ["config"], {});

    expect(config.sandbox.egress?.allow).toEqual(allow);
    expect(invocation.env.SANDBOX_EGRESS_ALLOW).toBe(JSON.stringify(allow));
    expect(invocation.args).toContain("--profile");
    expect(invocation.args).toContain("sandbox-egress");
    expect(invocation.args).toContain("infra/compose/docker-compose.egress.yml");
  });
});

describe("run", () => {
  it("starts through main with the default CLI runtime and suspends at the ask tool", async () => {
    const current = fixture();
    const inputPath = join(current.directory, "input.json");
    const result = await invokeCli(["--json", "run", "--input", inputPath]);
    expect(result.code).toBe(ExitCode.suspended);
    const run = jsonResult(RunResultSchema, result.stdout);
    expect(run.status).toBe("suspended");
    current.runId = run.runId;
    expect(current.callsBeforeApproval).toEqual([ALLOW_TOOL]);
    expect(current.callsAfterApproval).toEqual([]);
    const store = new SqliteEventStore(current.eventStorePath);
    try {
      const events = await readEvents(store, run.runId);
      const pending = events.find((event) => event.type === "approval_requested");
      expect(pending?.type).toBe("approval_requested");
      if (pending?.type !== "approval_requested") {
        throw new Error("The synthetic ask call did not request approval.");
      }
      current.approvalId = pending.approvalId;
      const checkpoint = await store.latestSnapshot(run.runId);
      expect(checkpoint).toBeDefined();
    } finally {
      await store.close();
    }
  });
});

describe("replay", () => {
  it("reports an unresolved approval as a missing result without printing event content", async () => {
    const current = fixture();
    const runId = current.runId;
    if (runId === undefined) {
      throw new Error("The run id is not available.");
    }

    const result = await invokeCli(["--json", "replay", "--run", runId]);

    expect(result.code).toBe(ExitCode.replayFailed);
    const report = jsonResult(ReplayReportSchema, result.stdout);
    expect(report.originalRunId).toBe(runId);
    expect(report.status).toBe("error");
    expect(report.divergence?.code).toBe("replay_missing_result");
    expect(result.stdout.join("")).not.toContain(current.canary);
  });
});

describe("MCP runtime", () => {
  it("exposes OAuth server login and logout through the CLI", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    const program = new Command();
    const context = createDefaultContext(program, output);

    expect(await main(["servers", "--help"], context)).toBe(ExitCode.ok);
    expect(stdout.join("")).toContain("login");
    expect(stdout.join("")).toContain("logout");
    expect(stderr).toEqual([]);
  });

  it("executes MCP tools through the CLI and validates edited approvals before recording", async () => {
    const current = fixture();
    const directory = join(current.directory, "mcp");
    const configPath = join(directory, "harness.yaml");
    const dataDirectory = join(directory, "data");
    const inputPath = join(directory, "input.json");
    const invalidEditPath = join(directory, "invalid.json");
    const allowedEditPath = join(directory, "allowed.json");
    const deniedEditPath = join(directory, "denied.json");
    await mkdir(directory, { recursive: true });
    await writeFile(inputPath, JSON.stringify({ goal: "call an MCP tool" }), "utf8");
    await writeFile(invalidEditPath, '{"value":42}', "utf8");
    await writeFile(allowedEditPath, '{"value":"edited"}', "utf8");
    await writeFile(deniedEditPath, '{"value":"blocked"}', "utf8");
    await writeFile(
      configPath,
      [
        "run:",
        "  checkpointEveryEvents: 2",
        "keys:",
        `  currentKeyId: ${KEY_ID}`,
        "  keys:",
        `    - id: ${KEY_ID}`,
        `      secret: ${KEY_REF}`,
        "servers:",
        "  - id: e2e_mcp",
        "    transport:",
        "      kind: stdio",
        "      command: in-memory",
        "    toolAllowlist: [send]",
        "    timeouts:",
        "      connectMs: 1000",
        "      callMs: 1000",
        "policy:",
        "  file: policy.yaml",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(directory, "policy.yaml"),
      [
        "version: 1",
        "defaultDecision: deny",
        "rules:",
        "  - id: ask_original",
        "    match:",
        "      tools: [e2e_mcp.send]",
        "      args:",
        "        - pointer: /value",
        "          op: equals",
        "          value: original",
        "    decision: ask",
        "    reason: approval_required",
        "    editable: [/value]",
        "  - id: allow_edited",
        "    match:",
        "      tools: [e2e_mcp.send]",
        "      args:",
        "        - pointer: /value",
        "          op: equals",
        "          value: edited",
        "    decision: allow",
        "    reason: edited_allowed",
        "  - id: allow_server_error",
        "    match:",
        "      tools: [e2e_mcp.send]",
        "      args:",
        "        - pointer: /value",
        "          op: equals",
        "          value: server_error",
        "    decision: allow",
        "    reason: server_error_test",
        "  - id: deny_blocked",
        "    match:",
        "      tools: [e2e_mcp.send]",
        "      args:",
        "        - pointer: /value",
        "          op: equals",
        "          value: blocked",
        "    decision: deny",
        "    reason: edited_denied",
        "",
      ].join("\n"),
      "utf8",
    );
    expect((await loadConfig({ configPath })).servers).toHaveLength(1);

    const inputSchema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    } satisfies Tool["inputSchema"];
    const serverPeers: {
      readonly server: McpServer;
      readonly serverTransport: Transport;
    }[] = [];
    const serverCalls: JsonValue[] = [];
    const createTransport = async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new McpServer({ name: "e2e-server", version: "1.0.0" });
      serverPeers.push({ server, serverTransport });
      server.server.registerCapabilities({ tools: { listChanged: true } });
      server.server.setRequestHandler("tools/list", () => ({
        tools: [{ name: "send", inputSchema }],
      }));
      server.server.setRequestHandler("tools/call", (request) => {
        const args = JsonValue.parse(request.params.arguments ?? null);
        serverCalls.push(args);
        if (
          args !== null &&
          typeof args === "object" &&
          !Array.isArray(args) &&
          args.value === "server_error"
        ) {
          return {
            isError: true,
            content: [{ type: "text", text: MCP_ERROR_CANARY }],
          };
        }
        return { content: [{ type: "text", text: "sent" }] };
      });
      await server.connect(serverTransport);
      return clientTransport;
    };
    const toolCall = (value: string) => ({
      callId: current.ids.next(),
      toolId: "e2e_mcp.send",
      args: { value },
    });
    const model = new FakeModelPort([
      completion([toolCall("original")], "request approval"),
      completion([], "completed"),
      completion([toolCall("original")], "request approval"),
      completion([], "completed"),
      completion([toolCall("server_error")], "call MCP"),
      completion([], "completed"),
    ]);

    try {
      const firstRun = await invokeMcpCli(configPath, dataDirectory, model, createTransport, [
        "--json",
        "run",
        "--input",
        inputPath,
        "--as",
        "e2e_operator",
      ]);
      expect(firstRun.code).toBe(ExitCode.suspended);
      const firstRunId = jsonResult(RunResultSchema, firstRun.stdout).runId;
      const store = new SqliteEventStore(join(dataDirectory, "harness.db"));
      let firstApprovalId: Id;
      try {
        const firstEvents = await readEvents(store, firstRunId);
        expect(firstEvents[0]).toMatchObject({
          type: "run_created",
          requestedBy: "cli.e2e_operator",
        });
        const approval = firstEvents.find((event) => event.type === "approval_requested");
        if (approval?.type !== "approval_requested") {
          throw new Error("The MCP call did not request approval.");
        }
        firstApprovalId = approval.approvalId;
      } finally {
        await store.close();
      }

      const appRuntime = await createRuntime(await loadConfig({ configPath }), {
        dataDir: dataDirectory,
        clock: current.clock,
        ids: current.ids,
        model: new FakeModelPort([]),
        roleConfigDirectory: dirname(configPath),
        secretResolver: new CompositeSecretResolver(),
        mcpTransportFactory: createTransport,
      });
      try {
        expect(await appRuntime.hasPendingApproval(firstRunId)).toBe(true);
        // Every run records its initial run_input; app content must not add another.
        const baselineEvents = await readEvents(
          new SqliteEventStore(join(dataDirectory, "harness.db")),
          firstRunId,
        );
        const countRunInputs = (events: readonly { readonly type: string }[]): number =>
          events.filter((event) => event.type === "run_input").length;
        const tokenized = await appRuntime.tokenizeAppContent(
          firstRunId,
          { message: current.canary },
          { boundary: "model_input" },
        );
        await appRuntime.onAppContent({
          runId: firstRunId,
          appId: Code.parse("approval.app"),
          kind: "message",
          content: tokenized,
        });
        const appEvents = await readEvents(
          new SqliteEventStore(join(dataDirectory, "harness.db")),
          firstRunId,
        );
        expect(appEvents.at(-1)).toMatchObject({
          type: "app_content",
          source: "app",
          label: "App-provided; untrusted",
          appId: "approval.app",
        });
        expect(JSON.stringify(appEvents.at(-1))).not.toContain(current.canary);
        expect(await appRuntime.hasPendingApproval(firstRunId)).toBe(true);
        expect(appEvents.some((event) => event.type === "approval_resolved")).toBe(false);
        expect(countRunInputs(appEvents)).toBe(countRunInputs(baselineEvents));
      } finally {
        await appRuntime.close();
      }

      const invalidEdit = await invokeMcpCli(configPath, dataDirectory, model, createTransport, [
        "--json",
        "approvals",
        "approve",
        firstApprovalId,
        "--yes",
        "--edit",
        invalidEditPath,
      ]);
      expect(invalidEdit.code).toBe(ExitCode.usage);
      expect(invalidEdit.stderr.join("")).toContain("edit_invalid");
      expect(invalidEdit.stderr.join("")).not.toContain("in-memory");
      const firstEventsAfterInvalid = new SqliteEventStore(join(dataDirectory, "harness.db"));
      try {
        expect(
          (await readEvents(firstEventsAfterInvalid, firstRunId)).some(
            (event) => event.type === "approval_resolved",
          ),
        ).toBe(false);
      } finally {
        await firstEventsAfterInvalid.close();
      }

      const approvedEdit = await invokeMcpCli(configPath, dataDirectory, model, createTransport, [
        "--json",
        "approvals",
        "approve",
        firstApprovalId,
        "--yes",
        "--edit",
        allowedEditPath,
        "--resume",
      ]);
      const firstRunEventsStore = new SqliteEventStore(join(dataDirectory, "harness.db"));
      let firstRunEvents: Event[];
      try {
        firstRunEvents = await readEvents(firstRunEventsStore, firstRunId);
      } finally {
        await firstRunEventsStore.close();
      }
      expect(approvedEdit.code).toBe(ExitCode.ok);
      expect(serverCalls).toEqual([{ value: "edited" }]);
      expect(firstRunEvents.find((event) => event.type === "approval_resolved")).toMatchObject({
        decision: "edit",
        approverId: "cli.local",
        edits: { value: "edited" },
      });

      const secondRun = await invokeMcpCli(configPath, dataDirectory, model, createTransport, [
        "--json",
        "run",
        "--input",
        inputPath,
      ]);
      expect(secondRun.code).toBe(ExitCode.suspended);
      const secondRunId = jsonResult(RunResultSchema, secondRun.stdout).runId;
      const secondStore = new SqliteEventStore(join(dataDirectory, "harness.db"));
      let secondApprovalId: Id;
      try {
        const secondEvents = await readEvents(secondStore, secondRunId);
        const approval = secondEvents.find((event) => event.type === "approval_requested");
        if (approval?.type !== "approval_requested") {
          throw new Error("The second MCP call did not request approval.");
        }
        secondApprovalId = approval.approvalId;
      } finally {
        await secondStore.close();
      }
      const deniedEdit = await invokeMcpCli(configPath, dataDirectory, model, createTransport, [
        "--json",
        "approvals",
        "approve",
        secondApprovalId,
        "--yes",
        "--edit",
        deniedEditPath,
        "--resume",
      ]);
      expect(deniedEdit.code).toBe(ExitCode.ok);
      expect(serverCalls).toEqual([{ value: "edited" }]);
      const deniedEventsStore = new SqliteEventStore(join(dataDirectory, "harness.db"));
      try {
        expect(
          (await readEvents(deniedEventsStore, secondRunId)).find(
            (event) => event.type === "tool_result",
          ),
        ).toMatchObject({ outcome: "denied", errorCode: "edited_denied" });
      } finally {
        await deniedEventsStore.close();
      }

      const errorRun = await invokeMcpCli(configPath, dataDirectory, model, createTransport, [
        "--json",
        "run",
        "--input",
        inputPath,
      ]);
      expect(errorRun.code).toBe(ExitCode.ok);
      const errorRunId = jsonResult(RunResultSchema, errorRun.stdout).runId;
      const errorEventsStore = new SqliteEventStore(join(dataDirectory, "harness.db"));
      try {
        const errorEvents = await readEvents(errorEventsStore, errorRunId);
        expect(errorEvents.find((event) => event.type === "tool_result")).toMatchObject({
          outcome: "error",
          errorCode: "tool_reported_error",
          result: { content: [{ text: MCP_ERROR_CANARY }] },
        });
        expect(JSON.stringify(errorEvents)).toContain(MCP_ERROR_CANARY);
      } finally {
        await errorEventsStore.close();
      }
      expect(serverCalls).toEqual([{ value: "edited" }, { value: "server_error" }]);
      expect(JSON.stringify(current.spans)).not.toContain(MCP_ERROR_CANARY);
      expect(JSON.stringify(current.logs)).not.toContain(MCP_ERROR_CANARY);
      expect(JSON.stringify({ stdout: errorRun.stdout, stderr: errorRun.stderr })).not.toContain(
        MCP_ERROR_CANARY,
      );
    } finally {
      await Promise.all(serverPeers.map(async ({ server }) => server.close()));
      await Promise.all(serverPeers.map(async ({ serverTransport }) => serverTransport.close()));
    }
  }, 15_000);

  it("sanitizes MCP descriptions and schema metadata before hosted fallback", async () => {
    const current = fixture();
    const directory = await mkdtemp(join(tmpdir(), "harness-mcp-pii-"));
    const canary = `mcp.${directory.split("/").at(-1) ?? "fixture"}@example.test`;
    const localRequests: ModelRequest[] = [];
    const localAdapter: ProviderAdapter = {
      provider: Code.parse("local"),
      kind: "openai",
      complete: (request) => {
        localRequests.push(request);
        return Promise.reject(new ProviderError("provider_unavailable"));
      },
    };
    const hostedAdapter = new FakeProvider(Code.parse("hosted"), [
      {
        parts: [{ type: "text", text: "completed" }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        latencyMs: 0,
      },
    ]);
    const server = new McpServer({ name: "pii-e2e-server", version: "1.0.0" });
    const inputSchema = {
      type: "object",
      description: `Schema contact ${canary}`,
      properties: {
        contact: {
          type: "string",
          title: `Contact ${canary}`,
          description: `Contact ${canary}`,
          default: canary,
          examples: [canary],
          enum: [canary],
        },
      },
    } satisfies Tool["inputSchema"];
    server.server.registerCapabilities({ tools: { listChanged: true } });
    server.server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "send", description: `Send to ${canary}`, inputSchema }],
    }));
    const createTransport = async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      return clientTransport;
    };
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        pii: PiiConfigSchema.parse({
          rules: [
            {
              entities: ["email"],
              boundaries: ["model_input"],
              destinations: ["local"],
              action: "allow",
            },
          ],
        }),
        models: ModelsConfigSchema.parse({
          retry: { maxAttempts: 1 },
          providers: [
            {
              id: "local",
              kind: "openai_compatible",
              baseUrl: "http://127.0.0.1:1234",
              trust: "local",
            },
            { id: "hosted", kind: "openai", trust: "hosted" },
          ],
          routing: {
            default: [
              { provider: "local", model: "local-model" },
              { provider: "hosted", model: "hosted-model" },
            ],
          },
        }),
        servers: ServersConfigSchema.parse([
          {
            id: "e2e_mcp",
            transport: { kind: "stdio", command: "in-memory" },
            toolAllowlist: ["send"],
          },
        ]),
      },
      {
        dataDir: directory,
        store: new InMemoryEventStore(),
        transientVault: true,
        clock: current.clock,
        ids: current.ids,
        providerAdapters: [localAdapter, hostedAdapter],
        mcpTransportFactory: createTransport,
        policy: {
          version: Code.parse("e2e.mcp_pii"),
          decide: () => ({
            decision: "allow",
            ruleId: Code.parse("e2e_allow"),
            reason: Code.parse("synthetic_allowed"),
            editable: [],
          }),
        },
      },
    );

    try {
      const result = await runtime.run(canary);

      expect(result.status).toBe("completed");
      expect(localRequests).toHaveLength(1);
      expect(JSON.stringify(localRequests[0])).toContain(canary);
      expect(hostedAdapter.requests).toHaveLength(1);
      expect(JSON.stringify(hostedAdapter.requests[0])).not.toContain(canary);
      expect(JSON.stringify(hostedAdapter.requests[0])).toContain("<EMAIL_1>");
    } finally {
      await runtime.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("uses the configured async detector before tokenizing through the runtime", async () => {
    const current = fixture();
    const directory = await mkdtemp(join(tmpdir(), "harness-presidio-runtime-"));
    const canary = "Alice Smith";
    const requestBodies: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Uint8Array[] = [];
      request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requestBodies.push(body);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify(
              body.includes(canary)
                ? [{ entity_type: "PERSON", start: 0, end: 11, score: 0.99 }]
                : [],
            ),
          );
      });
    });
    let listening = false;
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      listening = true;
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("The Presidio fixture did not bind a TCP port.");
      }
      runtime = await createRuntime(
        {
          run: RunConfigSchema.parse({}),
          pii: PiiConfigSchema.parse({
            presidio: { baseUrl: `http://127.0.0.1:${String(address.port)}` },
          }),
        },
        {
          dataDir: directory,
          store: new InMemoryEventStore(),
          transientVault: true,
          clock: current.clock,
          ids: current.ids,
        },
      );
      const run = runtime.start({});
      await run.started;
      void run.completion.catch(() => undefined);
      const sanitized = await runtime.tokenizeAppContent(
        run.runId,
        { message: canary },
        { boundary: "model_input" },
      );

      expect(JSON.stringify(sanitized)).toContain("<PERSON_NAME_1>");
      expect(JSON.stringify(sanitized)).not.toContain(canary);
      const requestBody = parseJson(
        z
          .object({
            text: z.string(),
            language: z.string(),
            score_threshold: z.number(),
          })
          .strict(),
        requestBodies.find((body) => body.includes(canary)) ?? "",
      );
      expect(requestBody).toEqual({ text: canary, language: "en", score_threshold: 0.5 });
      expect(Object.keys(requestBody)).toEqual(["text", "language", "score_threshold"]);
    } finally {
      await runtime?.close();
      if (listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        });
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function appApprovalFixture() {
  const directory = await mkdtemp(".e2e-app-approval-");
  const ids = new SequentialIdGenerator();
  const runId = Id.parse(ids.next());
  const clock = new FakeClock(10);
  const store = new InMemoryEventStore();
  const builders = createEventBuilders();
  const created = builders.runCreated(runId);
  await store.append(
    runId,
    [
      created,
      {
        runId,
        ts: created.ts,
        traceId: created.traceId,
        spanId: created.spanId,
        segmentId: created.segmentId,
        v: 1,
        type: "run_input",
        inputKind: "initial",
        input: "Synthetic app tool request",
      },
      builders.runStatusChanged(runId, "pending", "running"),
    ],
    0,
  );
  const execute = vi.fn<ToolPort["execute"]>(() =>
    Promise.resolve({ outcome: "ok", result: { delivered: true } }),
  );
  const tool: ToolPort = {
    describe: () => ({ idempotent: true, timeoutMs: 1000 }),
    prepare: (call) => Promise.resolve(call),
    execute,
  };
  let mode: "ask" | "allow" | "deny" = "ask";
  const policy: PolicyPort = {
    version: "app_approval_e2e",
    decide: (_call, context) => ({
      decision: context.app === "synthetic.app" ? mode : "deny",
      ruleId: "app_review",
      reason: "app_policy",
      editable: ["/value"],
      approvalTtlMs: 100,
    }),
  };
  const config = { run: RunConfigSchema.parse({}) };
  const overrides = {
    store,
    clock,
    ids,
    dataDir: directory,
    transientVault: true,
    sandboxBackend: unusedSandboxBackend,
    tool,
    policy,
    model: new FakeModelPort([completion([], "Done")]),
  };
  const runtime = await createRuntime(config, overrides);
  const handler = createPolicyCheckedAppCallHandler({
    policy,
    tool,
    nextCallId: () => Id.parse(ids.next()),
    onAppCallApproval: runtime.onAppCallApproval,
  });
  const call = {
    type: "app_call" as const,
    appId: Code.parse("synthetic.app"),
    sessionId: Id.parse(ids.next()),
    toolName: "synthetic.write",
    arguments: { value: "synthetic.app@example.test" },
  };
  const response = handler(call, {
    runId,
    policyContext: { subagent: false, app: Code.parse("synthetic.app") },
  });
  await vi.waitFor(async () => {
    expect(await runtime.hasPendingApproval(runId)).toBe(true);
  });
  const events = await readEvents(store, runId);
  const approval = events.find((event) => event.type === "approval_requested");
  if (approval?.type !== "approval_requested") {
    throw new Error("Missing app approval");
  }
  return {
    directory,
    runtime,
    response,
    approval,
    events,
    runId,
    store,
    execute,
    clock,
    config,
    overrides,
    setMode: (value: typeof mode) => {
      mode = value;
    },
  };
}

describe("app-call runtime approval", () => {
  it.each(["approve", "deny", "edit", "edited_deny", "expiry", "crash"] as const)(
    "uses the existing durable approval and resume path for %s",
    async (decision) => {
      const current = await appApprovalFixture();
      let restarted: Awaited<ReturnType<typeof createRuntime>> | undefined;
      try {
        expect(current.execute).not.toHaveBeenCalled();
        expect(foldRunState(current.events).status).toBe("suspended");
        expect(current.events.filter((event) => event.type === "tool_intent")).toHaveLength(1);
        expect(current.events.filter((event) => event.type === "approval_requested")).toHaveLength(
          1,
        );
        expect(JSON.stringify(current.events)).not.toContain("synthetic.app@example.test");
        const human = {
          metadata: { decidedBy: "human" as const, approverId: Code.parse("cli.app_e2e") },
        };
        const edited = decision === "edit" || decision === "edited_deny";
        if (decision === "expiry") {
          await current.runtime.resolveApproval(
            current.runId,
            current.approval.approvalId,
            "deny",
            {
              metadata: { decidedBy: "expiry", reason: Code.parse("expired") },
            },
          );
        } else {
          let resolution: "approve" | "deny" | "edit" = "approve";
          if (edited) {
            resolution = "edit";
          }
          if (decision === "deny") {
            resolution = "deny";
          }
          await current.runtime.resolveApproval(
            current.runId,
            current.approval.approvalId,
            resolution,
            edited ? { ...human, edits: { value: "synthetic.edited@example.test" } } : human,
          );
        }
        if (decision === "edit") {
          current.setMode("allow");
        }
        if (decision === "edited_deny" || decision === "crash") {
          current.setMode("deny");
        }
        if (decision === "crash") {
          restarted = await createRuntime(current.config, current.overrides);
        }
        await (restarted ?? current.runtime).resume(current.runId);
        const result = await current.response;
        const allowed = decision === "approve" || decision === "edit";
        expect(result.isError).toBe(!allowed);
        expect(current.execute).toHaveBeenCalledTimes(allowed ? 1 : 0);
        let expected = "app_policy";
        if (allowed) {
          expected = '{"delivered":true}';
        }
        if (decision === "deny") {
          expected = "approval_denied";
        }
        if (decision === "expiry") {
          expected = "approval_expired";
        }
        expect(result.content).toEqual([{ type: "text", text: expected }]);
        const after = await readEvents(current.store, current.runId);
        expect(after.filter((event) => event.type === "tool_intent")).toHaveLength(1);
        expect(JSON.stringify(after)).not.toContain("synthetic.edited@example.test");
      } finally {
        await restarted?.close();
        await current.runtime.close();
        await rm(current.directory, { recursive: true, force: true });
      }
    },
  );
});

describe("approval", () => {
  it("delivers configured webhook metadata once with the approval idempotency key", async () => {
    const current = fixture();
    const approvalId = current.approvalId;
    if (approvalId === undefined) {
      throw new Error("The approval id is not available.");
    }
    const deliveries: {
      readonly body: string;
      readonly idempotencyKey: string | null;
      readonly authorization: string | null;
    }[] = [];
    const server = createServer((request, response) => {
      const chunks: Uint8Array[] = [];
      request.on("data", (chunk: Uint8Array) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        deliveries.push({
          body: Buffer.concat(chunks).toString("utf8"),
          idempotencyKey: headerValue(request.headers["idempotency-key"]),
          authorization: headerValue(request.headers.authorization),
        });
        response.writeHead(204).end();
      });
    });
    const oldConfig = await readFile(current.configPath, "utf8");
    const oldSecret = process.env.HARNESS_E2E_APPROVAL_TOKEN;
    const secret = "E2E_APPROVAL_WEBHOOK_SECRET_CANARY";
    let listening = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "localhost", resolve);
      });
      listening = true;
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("The capture server did not bind a TCP port.");
      }
      const updatedConfig = oldConfig.replace(
        "policy:\n  file: policy.yaml",
        [
          "policy:",
          "  file: policy.yaml",
          "  approvals:",
          "    allowInsecureLocalhost: true",
          "    notifier:",
          "      kind: webhook",
          `      url: http://localhost:${String(address.port)}/approval`,
          "      secretRef: env:HARNESS_E2E_APPROVAL_TOKEN",
          "      timeoutMs: 2000",
        ].join("\n"),
      );
      if (updatedConfig === oldConfig) {
        throw new Error("The integration config did not contain the policy fragment.");
      }
      await writeFile(current.configPath, updatedConfig, "utf8");
      process.env.HARNESS_E2E_APPROVAL_TOKEN = secret;
      current.clock.advance(1);

      const result = await invokeCli(["--json", "approvals", "sweep"]);

      expect(result.code).toBe(ExitCode.ok);
      expect(jsonResult(ApprovalSweepResultSchema, result.stdout)).toMatchObject({
        escalated: 1,
        failed: 0,
      });
      expect(deliveries).toHaveLength(1);
      const delivery = deliveries[0];
      if (delivery === undefined) {
        throw new Error("The capture server did not receive the escalation.");
      }
      const notification = parseJson(ApprovalNotificationSchema, delivery.body);
      expect(notification.approvalId).toBe(approvalId);
      expect(notification.idempotencyKey).toBe(approvalId);
      expect(delivery.idempotencyKey).toBe(approvalId);
      expect(delivery.authorization).toBe("Bearer " + secret);
      expect(delivery.body).not.toContain(secret);
      expect(delivery.body).not.toContain(current.canary);
      expect(JSON.stringify({ result, spans: current.spans, logs: current.logs })).not.toContain(
        secret,
      );
    } finally {
      await writeFile(current.configPath, oldConfig, "utf8");
      if (oldSecret === undefined) {
        delete process.env.HARNESS_E2E_APPROVAL_TOKEN;
      } else {
        process.env.HARNESS_E2E_APPROVAL_TOKEN = oldSecret;
      }
      if (listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        });
      }
    }
  });

  it("lists and shows tokenized approval details and does not execute the ask tool", async () => {
    const current = fixture();
    const approvalId = current.approvalId;
    if (approvalId === undefined) {
      throw new Error("The approval id is not available.");
    }
    const list = await invokeCli(["--json", "approvals", "list"], false);
    expect(list.code).toBe(ExitCode.ok);
    const listed = jsonResult(ApprovalListResultSchema, list.stdout);
    expect(listed.approvals).toHaveLength(1);
    expect(listed.approvals[0]?.approvalId).toBe(approvalId);

    const show = await invokeCli(["--json", "approvals", "show", approvalId, "--show-args"], false);
    expect(show.code).toBe(ExitCode.ok);
    const displayed = jsonResult(ApprovalShowResultSchema, show.stdout);
    expect(displayed.approvalId).toBe(approvalId);
    current.approvalOutput.push(...list.stdout, ...list.stderr, ...show.stdout, ...show.stderr);
    expect(current.callsAfterApproval).toEqual([]);

    const runId = current.runId;
    if (runId === undefined) {
      throw new Error("The run id is not available.");
    }
    const config = await current.context.loadConfig();
    if (config.keys === undefined) {
      throw new Error("The integration fixture requires configured encryption keys.");
    }
    const keys = new LocalKeyProvider({
      config: config.keys,
      secretResolver: new CompositeSecretResolver({
        env: new EnvSecretResolver(process.env),
        file: new FileSecretResolver(),
      }),
      env: process.env,
      onWarning: () => undefined,
    });
    const foreignVault = new SqliteVault(join(current.dataDirectory, "vault.db"), keys, () =>
      current.clock.now(),
    );
    try {
      expect(
        await foreignVault.put(Id.parse("00000000000000000000000099"), "phone", "555-0101"),
      ).toBe("<PHONE_1>");
    } finally {
      foreignVault.close();
      keys.dispose();
    }

    const reveal = await invokeCli(["--json", "approvals", "show", approvalId, "--reveal"], false);
    expect(reveal.code).toBe(ExitCode.ok);
    expect(reveal.stderr.join("")).toContain("reveal_exposes_sensitive_values");
    const revealed = jsonResult(ApprovalShowResultSchema, reveal.stdout);
    expect(revealed.args).toEqual({ email: "<EMAIL_1>", foreign: "<PHONE_1>" });
    expect(revealed.revealed).toEqual({ email: current.canary, foreign: "<PHONE_1>" });
    expectCanaryOnlyInRevealed(reveal, current.canary);

    const child = await seedChildApproval(current, runId);
    const childReveal = await invokeCli(
      ["--json", "approvals", "show", child.approvalId, "--reveal"],
      false,
    );
    expect(childReveal.code).toBe(ExitCode.ok);
    expect(childReveal.stderr.join("")).toContain("reveal_exposes_sensitive_values");
    const childRevealed = jsonResult(ApprovalShowResultSchema, childReveal.stdout);
    expect(childRevealed.runId).toBe(child.childRunId);
    expect(childRevealed.args).toEqual({ email: "<EMAIL_1>", foreign: "<PHONE_1>" });
    expect(childRevealed.revealed).toEqual({ email: current.canary, foreign: "<PHONE_1>" });
    expectCanaryOnlyInRevealed(childReveal, current.canary);

    const store = new SqliteEventStore(current.eventStorePath);
    try {
      const audit = (await readEvents(store, runId)).filter(
        (event): event is Extract<Event, { type: "pii_action" }> =>
          event.type === "pii_action" && event.boundary === "ui",
      );
      expect(audit).toHaveLength(2);
      expect(audit.map(({ action, entities }) => ({ action, entities }))).toEqual(
        expect.arrayContaining([
          { action: "detokenized", entities: [{ type: "email", count: 1 }] },
          { action: "blocked", entities: [{ type: "phone", count: 1 }] },
        ]),
      );
      expect(JSON.stringify(audit)).not.toContain(current.canary);

      const childAudit = (await readEvents(store, child.childRunId)).filter(
        (event): event is Extract<Event, { type: "pii_action" }> =>
          event.type === "pii_action" && event.boundary === "ui",
      );
      expect(childAudit).toHaveLength(2);
      expect(childAudit.map(({ action, entities }) => ({ action, entities }))).toEqual(
        expect.arrayContaining([
          { action: "detokenized", entities: [{ type: "email", count: 1 }] },
          { action: "blocked", entities: [{ type: "phone", count: 1 }] },
        ]),
      );
      expect(JSON.stringify(childAudit)).not.toContain(current.canary);
    } finally {
      await store.close();
    }

    const approved = await invokeCli(["--json", "approvals", "approve", approvalId, "--yes"]);
    expect(approved.code).toBe(ExitCode.ok);
    expect(current.callsAfterApproval).toEqual([]);
  });

  it("returns reveal_unavailable when keys are not configured", async () => {
    const current = fixture();
    const approvalId = current.approvalId;
    if (approvalId === undefined) {
      throw new Error("The approval id is not available.");
    }
    const config = { ...(await current.context.loadConfig()) };
    delete config.keys;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const context: CliContext = {
      ...current.context,
      loadConfig: () => Promise.resolve(config),
      out: createOutput({
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      }),
    };

    expect(await main(["--json", "approvals", "show", approvalId, "--reveal"], context)).toBe(
      ExitCode.failure,
    );
    expect(stderr).toEqual(["reveal_unavailable\n"]);
    expect(stdout).toEqual([]);
  });
});

describe("resume", () => {
  it("worker executes an approved ask only after recording approval and completes the run", async () => {
    const current = fixture();
    const runId = current.runId;
    if (runId === undefined) {
      throw new Error("The run id is not available.");
    }
    current.sentinelProbe.enabled = true;
    const config = await current.context.loadConfig();
    const queue = await openConfiguredRunQueue(config, {
      dataDir: current.dataDirectory,
      clock: current.clock,
      ids: current.ids,
    });
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      runtime = await createRuntime(config, {
        queue,
        dataDir: current.dataDirectory,
        clock: current.clock,
        ids: current.ids,
        model: current.model,
        roleConfigDirectory: current.directory,
        secretResolver: new CompositeSecretResolver(),
        sandboxBackend: unusedSandboxBackend,
        tool: syntheticTools(
          current.callsBeforeApproval,
          current.callsAfterApproval,
          current.argsAfterApproval,
        ),
      });
      const control: { worker?: Worker } = {};
      const worker = new Worker({
        queue,
        ids: current.ids,
        clock: current.clock,
        execute: async (job, signal) => {
          const resumed = await runtime?.resume(job.runId, { signal });
          control.worker?.stop();
          if (resumed === undefined) {
            throw new Error("The worker runtime was not initialized.");
          }
          return resumed;
        },
      });
      control.worker = worker;
      await worker.run();
      expect(await queue.claim("worker.verify", 1, 30_000)).toEqual([]);
    } finally {
      try {
        await runtime?.close();
      } finally {
        await queue.close();
      }
    }
    expect(current.callsAfterApproval).toEqual([ASK_TOOL]);
    expect(current.argsAfterApproval).toEqual([{ email: current.canary, foreign: "<PHONE_1>" }]);

    const store = new SqliteEventStore(current.eventStorePath);
    try {
      const events = await readEvents(store, runId);
      const resolved = events.findIndex(
        (event) => event.type === "approval_resolved" && event.approvalId === current.approvalId,
      );
      const executed = events.findIndex(
        (event) => event.type === "tool_result" && event.toolId === ASK_TOOL,
      );
      expect(resolved).toBeGreaterThanOrEqual(0);
      expect(executed).toBeGreaterThan(resolved);
      expect(events.at(-1)).toMatchObject({
        type: "pii_action",
        boundary: "telemetry_export",
        action: "blocked",
        entities: [{ type: "email", count: 1 }],
      });
      expect(JSON.stringify(events.at(-1))).not.toContain(current.canary);
      expect(JSON.stringify(current.spans)).not.toContain(current.canary);
      expect(JSON.stringify(current.logs)).not.toContain(current.canary);
      expect(
        events.some((event) => event.type === "run_status_changed" && event.to === "completed"),
      ).toBe(true);
      expect(
        events.find((event) => event.type === "tool_result" && event.toolId === ASK_TOOL),
      ).toMatchObject({ result: { ok: true, email: "<EMAIL_1>" } });
      current.toolCallEvents = events.filter(
        (event) => event.type === "tool_intent" || event.type === "tool_result",
      );
      expect(await store.latestSnapshot(runId)).toBeDefined();
      const vaultDatabase = new Database(join(current.dataDirectory, "vault.db"), {
        readonly: true,
      });
      try {
        const terminal = vaultDatabase
          .prepare<[string], { readonly terminal_at: number }>(
            "SELECT terminal_at FROM run_meta WHERE run_id = ?",
          )
          .get(runId);
        expect(terminal?.terminal_at).toBe(current.clock.now());
      } finally {
        vaultDatabase.close();
      }
      const database = new Database(current.eventStorePath, { readonly: true });
      try {
        const eventRows = database
          .prepare<[], { readonly content_blob: string }>(
            "SELECT content_blob FROM events ORDER BY global_seq",
          )
          .all();
        const snapshotRows = database
          .prepare<[], { readonly content_blob: string }>(
            "SELECT content_blob FROM snapshots ORDER BY at_seq",
          )
          .all();
        current.eventStoreBytes = Buffer.from(
          eventRows.map(({ content_blob }) => content_blob).join("\n"),
          "utf8",
        );
        current.snapshotBytes = Buffer.from(
          snapshotRows.map(({ content_blob }) => content_blob).join("\n"),
          "utf8",
        );
      } finally {
        database.close();
      }
    } finally {
      await store.close();
    }
  });

  it("resumes an in-flight child through the runtime and delivers its result once", async () => {
    const store = new InMemoryEventStore();
    const childToolId = Code.parse("e2e.child_write");
    const spawnCallId = Id.parse("77777777777777777777777771");
    const childCallId = Id.parse("77777777777777777777777772");
    let parentCalls = 0;
    let childCalls = 0;
    let childWrites = 0;
    const model: ModelPort = {
      complete: (request) => {
        if (request.role === "worker") {
          childCalls += 1;
          return Promise.resolve(
            childCalls === 1
              ? completion(
                  [{ callId: childCallId, toolId: childToolId, args: { value: "synthetic" } }],
                  "write one value",
                )
              : completion([], "child complete"),
          );
        }
        parentCalls += 1;
        return Promise.resolve(
          parentCalls === 1
            ? completion(
                [
                  {
                    callId: spawnCallId,
                    toolId: "agent.spawn",
                    args: { role: "worker", goal: "write one value" },
                  },
                ],
                "spawn one child",
              )
            : completion([], "parent complete"),
        );
      },
    };
    const tool: ToolPort = {
      describe: (toolId) =>
        toolId === childToolId ? { idempotent: false, timeoutMs: 1_000 } : undefined,
      getToolSpecs: () => [
        { toolId: childToolId, description: "Write once", inputSchema: { type: "object" } },
      ],
      execute: () => {
        childWrites += 1;
        return Promise.resolve({ outcome: "ok", result: { written: true } });
      },
    };
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        pii: PiiConfigSchema.parse({ enabled: false }),
        models: ModelsConfigSchema.parse({
          routing: {
            default: [{ provider: "local", model: "parent" }],
            roles: { worker: [{ provider: "local", model: "worker" }] },
          },
        }),
        roles: [
          { id: "worker", route: "worker", tools: [childToolId], maxDepth: 2, maxChildren: 1 },
        ],
      },
      {
        store,
        clock: new FakeClock(1_000),
        ids: new SequentialIdGenerator(),
        model,
        tool,
        context: new NaiveContext(),
        policy: {
          version: Code.parse("e2e.policy"),
          decide: (call) => ({
            decision: call.toolId === childToolId ? "ask" : "allow",
            ruleId: Code.parse("e2e.rule"),
            reason: "e2e_decision",
            editable: [],
          }),
        },
        transientVault: true,
      },
    );
    try {
      const initial = await runtime.run("delegate a write");
      expect(initial.status).toBe("suspended");
      const parentRunId = initial.events[0]?.runId;
      if (parentRunId === undefined) {
        throw new Error("Expected the parent run id.");
      }
      const parentEvents = await readEvents(store, parentRunId);
      const spawn = parentEvents.find((event) => event.type === "subagent_spawned");
      if (spawn?.type !== "subagent_spawned") {
        throw new Error("Expected a durable child announcement.");
      }
      const childEvents = await readEvents(store, spawn.childRunId);
      const approval = childEvents.find((event) => event.type === "approval_requested");
      if (approval?.type !== "approval_requested") {
        throw new Error("Expected the child approval request.");
      }

      await runtime.resolveApproval(spawn.childRunId, approval.approvalId, "approve", {
        metadata: { decidedBy: "human", approverId: "cli.test" },
      });
      const resumed = await runtime.resume(parentRunId);
      const completedParentEvents = await readEvents(store, parentRunId);
      expect(resumed.status).toBe("completed");
      expect(childWrites).toBe(1);
      expect(
        completedParentEvents.filter((event) => event.type === "subagent_spawned"),
      ).toHaveLength(1);
      expect(
        completedParentEvents.filter((event) => event.type === "subagent_completed"),
      ).toHaveLength(1);
      expect(
        completedParentEvents.filter(
          (event) => event.type === "tool_result" && event.callId === spawnCallId,
        ),
      ).toHaveLength(1);
      expect(childCalls).toBe(2);
    } finally {
      await runtime.close();
    }
  });
});

async function dockerAvailable(): Promise<boolean> {
  try {
    await runNetworkIsolationCompose(`harness-sandbox-probe-${String(process.pid)}`, [
      "ps",
      "--quiet",
    ]);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!(await dockerAvailable()))("configured remote sandbox", () => {
  // threat: T-18
  it("executes through the runtime-selected runner and records only safe metadata", async () => {
    const current = fixture();
    const directory = await mkdtemp(join(tmpdir(), "harness-sandbox-e2e-"));
    const token = "synthetic-e2e-runner-token-for-task-19.11";
    const tokenRef = SecretRefSchema.parse("env:HARNESS_SANDBOX_E2E_TOKEN");
    const project = `harness-sandbox-e2e-${String(process.pid)}`;
    const previousRunnerToken = process.env.SANDBOX_RUNNER_TOKEN;
    process.env.SANDBOX_RUNNER_TOKEN = token;
    const invokeCompose = (args: string[]) =>
      runNetworkIsolationCompose(project, ["--profile", "sandbox", ...args]);
    const requestSchema = z.union([
      z.object({ runId: Id, spec: ExecSpecSchema }).strict(),
      z.object({ runId: Id, ttlMs: z.number().int().positive().max(600_000).optional() }).strict(),
      z.object({ runId: Id }).strict(),
    ]);
    const responseSchema = z.object({ status: z.number().int(), body: z.string() }).strict();
    const composeSchema = z.object({
      networks: z.record(z.string(), z.object({ internal: z.boolean().optional() })),
      services: z.record(
        z.string(),
        z.object({
          ports: z.array(z.unknown()).optional(),
          networks: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    });
    const responses: z.infer<typeof responseSchema>[] = [];
    const forwarded: {
      path: string;
      body: z.infer<typeof requestSchema>;
      authorization: string | undefined;
    }[] = [];

    // The host cannot reach Compose's internal network. Forward real HTTP requests
    // from the configured remote backend without publishing a runner port.
    const bridge = createServer((request, response) => {
      const forward = async () => {
        expect(request.method).toBe("POST");
        const path = request.url;
        if (path !== "/lease" && path !== "/exec" && path !== "/release") {
          throw new Error("Unexpected sandbox endpoint.");
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = z.instanceof(Buffer).parse(chunk);
          bytes += buffer.byteLength;
          if (bytes > 2 * 1024 * 1024) {
            throw new Error("Sandbox request exceeds the boundary limit.");
          }
          chunks.push(buffer);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        forwarded.push({
          path,
          body: parseJson(requestSchema, body, { maxBytes: 2 * 1024 * 1024 }),
          authorization: request.headers.authorization,
        });
        const script = [
          'const http = require("node:http");',
          `const request = http.request({ hostname: "127.0.0.1", port: 8080, path: ${JSON.stringify(path)}, method: "POST", headers: ${JSON.stringify({ host: "sandbox-runner:8080", authorization: request.headers.authorization, "content-type": "application/json" })} }, (response) => {`,
          '  const chunks = []; let bytes = 0; response.on("data", (chunk) => { bytes += chunk.length; if (bytes > 2097152) { response.destroy(); process.exitCode = 1; } else { chunks.push(chunk); } });',
          '  response.on("end", () => process.stdout.write(JSON.stringify({ status: response.statusCode, body: Buffer.concat(chunks).toString() })));',
          "});",
          "request.setTimeout(10000, () => request.destroy());",
          'request.on("error", () => { process.exitCode = 1; });',
          `request.end(${JSON.stringify(body)});`,
        ].join("\n");
        const stdout = await invokeCompose([
          "exec",
          "--no-TTY",
          "sandbox-runner",
          "node",
          "-e",
          script,
        ]);
        const remote = parseJson(responseSchema, stdout, { maxBytes: 2 * 1024 * 1024 });
        responses.push(remote);
        response.writeHead(remote.status, { "content-type": "application/json" });
        response.end(remote.body);
      };
      void forward().catch(() => {
        response.writeHead(502);
        response.end();
      });
    });
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      const compose = parseJson(composeSchema, await invokeCompose(["config", "--format", "json"]));
      expect(compose.networks.sandbox?.internal).toBe(true);
      expect(compose.services["sandbox-runner"]?.ports ?? []).toEqual([]);
      expect(Object.keys(compose.services["sandbox-runner"]?.networks ?? {})).toEqual(["sandbox"]);
      await invokeCompose([
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "60",
        "--pull=missing",
        "sandbox-runner",
      ]);
      await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
      const address = bridge.address();
      if (address === null || typeof address === "string") {
        throw new Error("The sandbox test bridge is not listening.");
      }
      const store = new InMemoryEventStore();
      const executions: Awaited<ReturnType<SandboxExecTool["execute"]>>[] = [];
      const createTool = vi.fn((backend: SandboxBackend): ToolPort => {
        const tool = new SandboxExecTool({
          backend,
          limits: { memoryMb: 2048, pids: 2048, outputBytes: 2048, cpuSeconds: 5 },
        });
        return {
          describe: (toolId) => tool.describe(toolId),
          execute: async (call, context) => {
            const output = await tool.execute(call, context);
            executions.push(output);
            const boundedOutput = z
              .object({
                exitCode: z.number().int().nullable(),
                stdout: z.string(),
              })
              .parse(output.result);
            return {
              outcome: "ok",
              result: {
                exitCode: boundedOutput.exitCode,
                bytes: Buffer.byteLength(boundedOutput.stdout, "utf8"),
              },
            };
          },
        };
      });
      runtime = await createRuntime(
        {
          run: RunConfigSchema.parse({}),
          pii: PiiConfigSchema.parse({
            detokenize: [{ toolId: "sandbox.exec", args: ["/argv/1"] }],
          }),
          sandbox: { runner: { url: `http://127.0.0.1:${String(address.port)}`, token: tokenRef } },
        },
        {
          store,
          dataDir: directory,
          transientVault: true,
          clock: new FakeClock(1_000),
          ids: new SequentialIdGenerator(),
          secretResolver: {
            resolve: (ref) => {
              expect(ref).toBe(tokenRef);
              return Promise.resolve({ reveal: () => token });
            },
          },
          policy: {
            version: Code.parse("e2e.sandbox"),
            decide: () => ({
              decision: "allow",
              ruleId: Code.parse("e2e_sandbox"),
              reason: Code.parse("synthetic_allowed"),
              editable: [],
            }),
          },
          model: new FakeModelPort([
            completion(
              [
                {
                  callId: "00000000000000000000000010",
                  toolId: "sandbox.exec",
                  args: { argv: ["/bin/echo", current.canary], timeoutMs: 10_000 },
                },
              ],
              "execute",
            ),
            completion([], "completed"),
          ]),
          createTool,
        },
      );
      expect(runtime.sandboxBackend).toBeInstanceOf(RemoteSandboxBackend);
      expect(createTool).toHaveBeenCalledExactlyOnceWith(runtime.sandboxBackend);
      const result = await runtime.run("Execute the synthetic sandbox command.");
      expect(result.status).toBe("completed");
      expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
      expect(executions).toMatchObject([
        {
          outcome: "ok",
          result: { exitCode: 0, stdout: `${current.canary}\n` },
        },
      ]);
      expect(forwarded.map(({ path }) => path)).toEqual(["/lease", "/exec", "/release"]);
      expect(forwarded[1]).toMatchObject({
        authorization: ["Bearer", token].join(" "),
        body: { spec: { argv: ["/bin/echo", current.canary] } },
      });
      expect(result.events.find((event) => event.type === "tool_result")).toMatchObject({
        outcome: "ok",
        result: { exitCode: 0, bytes: Buffer.byteLength(`${current.canary}\n`, "utf8") },
      });
      const safeEvents = result.events
        .map((event) => toSafeEvent(event, Code.parse("e2e.sandbox")))
        .filter((event) => event !== null);
      expect(safeEvents.some((event) => event.kind === "tool_call")).toBe(true);
      expect(safeEvents.every((event) => !("args" in event) && !("result" in event))).toBe(true);
      for (const content of [
        JSON.stringify(result.events),
        JSON.stringify(safeEvents),
        JSON.stringify(current.spans),
        JSON.stringify(current.logs),
      ]) {
        expect(content).not.toContain(current.canary);
        expect(content).not.toContain(token);
      }
      expect(JSON.stringify(safeEvents)).not.toContain("/bin/echo");
    } finally {
      try {
        try {
          await runtime?.close();
        } finally {
          if (bridge.listening) {
            await new Promise<void>((resolve, reject) =>
              bridge.close((error) => {
                if (error === undefined) {
                  resolve();
                } else {
                  reject(error);
                }
              }),
            );
          }
        }
      } finally {
        try {
          await invokeCompose(["down", "--volumes", "--remove-orphans"]);
        } finally {
          if (previousRunnerToken === undefined) {
            delete process.env.SANDBOX_RUNNER_TOKEN;
          } else {
            process.env.SANDBOX_RUNNER_TOKEN = previousRunnerToken;
          }
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }, 240_000);

  // threat: T-05
  it("runs web and workspace file tools through runtime PII boundaries", async () => {
    const current = fixture();
    const directory = await mkdtemp(join(tmpdir(), "harness-web-fetch-e2e-"));
    const token = "synthetic-e2e-runner-token-for-web-fetch";
    const tokenRef = SecretRefSchema.parse("env:HARNESS_SANDBOX_E2E_TOKEN");
    const project = `harness-web-fetch-e2e-${String(process.pid)}`;
    const probeHost = "web-fetch-egress-probe.test";
    const allow = [{ host: probeHost, ports: [8080] }];
    const previousRunnerToken = process.env.SANDBOX_RUNNER_TOKEN;
    const previousEgressAllow = process.env.SANDBOX_EGRESS_ALLOW;
    const previousEgressEnvironment = {
      SANDBOX_EGRESS_SUBNET: process.env.SANDBOX_EGRESS_SUBNET,
      SANDBOX_EGRESS_PROXY_IP: process.env.SANDBOX_EGRESS_PROXY_IP,
      EGRESS_TEST_SUBNET: process.env.EGRESS_TEST_SUBNET,
      EGRESS_PROBE_IP: process.env.EGRESS_PROBE_IP,
      EGRESS_PROBE_HOST: process.env.EGRESS_PROBE_HOST,
    };
    process.env.SANDBOX_RUNNER_TOKEN = token;
    process.env.SANDBOX_EGRESS_ALLOW = JSON.stringify(allow);
    process.env.SANDBOX_EGRESS_SUBNET = "172.31.252.0/24";
    process.env.SANDBOX_EGRESS_PROXY_IP = "172.31.252.3";
    process.env.EGRESS_TEST_SUBNET = "198.51.102.0/24";
    process.env.EGRESS_PROBE_IP = "198.51.102.3";
    process.env.EGRESS_PROBE_HOST = probeHost;
    const invokeCompose = (args: string[]) =>
      runNetworkIsolationCompose(project, args, [
        "infra/compose/docker-compose.egress.yml",
        "infra/compose/docker-compose.egress.test.yml",
      ]);
    const requestSchema = z.union([
      z.object({ runId: Id, ttlMs: z.number().int().positive().max(600_000).optional() }).strict(),
      z.object({ runId: Id }).strict(),
      z.object({ runId: Id, request: WebFetchRequestSchema }).strict(),
      z.object({ runId: Id, request: FsOperationRequestSchema }).strict(),
    ]);
    const responseSchema = z.object({ status: z.number().int(), body: z.string() }).strict();
    const forwarded: z.infer<typeof requestSchema>[] = [];
    const responses: z.infer<typeof responseSchema>[] = [];
    const bridge = createServer((request, response) => {
      const forward = async () => {
        expect(request.method).toBe("POST");
        const endpoint = request.url ?? "";
        expect(
          endpoint === "/lease" ||
            endpoint === "/release" ||
            endpoint === "/fetch" ||
            endpoint.startsWith("/fs/"),
        ).toBe(true);
        const requestLimit = endpoint.startsWith("/fs/") ? 32 * 1024 * 1024 : 2 * 1024 * 1024;
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = z.instanceof(Buffer).parse(chunk);
          bytes += buffer.byteLength;
          if (bytes > requestLimit) {
            throw new Error("Web fetch request exceeds the boundary limit.");
          }
          chunks.push(buffer);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const parsed = parseJson(requestSchema, body, { maxBytes: requestLimit });
        forwarded.push(parsed);
        const script = [
          'const http = require("node:http");',
          `const request = http.request({ hostname: "127.0.0.1", port: 8080, path: ${JSON.stringify(endpoint)}, method: "POST", headers: ${JSON.stringify({ host: "sandbox-runner:8080", authorization: request.headers.authorization, "content-type": "application/json" })} }, (response) => {`,
          '  const chunks = []; let bytes = 0; response.on("data", (chunk) => { bytes += chunk.length; if (bytes > 2097152) { response.destroy(); process.exitCode = 1; } else { chunks.push(chunk); } });',
          '  response.on("end", () => process.stdout.write(JSON.stringify({ status: response.statusCode, body: Buffer.concat(chunks).toString() })));',
          "});",
          "request.setTimeout(10000, () => request.destroy());",
          'request.on("error", () => { process.exitCode = 1; });',
          `request.end(${JSON.stringify(body)});`,
        ].join("\n");
        const stdout = await invokeCompose([
          "exec",
          "--no-TTY",
          "sandbox-runner",
          "node",
          "-e",
          script,
        ]);
        const remote = parseJson(responseSchema, stdout, { maxBytes: 2 * 1024 * 1024 });
        responses.push(remote);
        response.writeHead(remote.status, { "content-type": "application/json" });
        response.end(remote.body);
      };
      void forward().catch(() => {
        response.writeHead(502);
        response.end();
      });
    });
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      await invokeCompose([
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "60",
        "--pull=missing",
        "sandbox-runner",
        "sandbox-egress-proxy",
        "egress-probe",
      ]);
      await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
      const address = bridge.address();
      if (address === null || typeof address === "string") {
        throw new Error("The web.fetch test bridge is not listening.");
      }
      const fileCanary = "workspace.file@example.test";
      const model = new FakeModelPort([
        completion(
          [
            {
              callId: "00000000000000000000000020",
              toolId: "web.fetch",
              args: { url: `http://${probeHost}:8080/runtime` },
            },
            {
              callId: "00000000000000000000000021",
              toolId: "fs.write",
              args: {
                path: "notes.txt",
                content: fileCanary,
                mode: "create",
                expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              },
            },
            {
              callId: "00000000000000000000000022",
              toolId: "fs.read",
              args: { path: "notes.txt" },
            },
          ],
          "fetch",
        ),
        completion([], "completed"),
      ]);
      const decide = vi.fn(() => ({
        decision: "allow" as const,
        ruleId: Code.parse("e2e_web_fetch"),
        reason: Code.parse("synthetic_allowed"),
        editable: [],
      }));
      runtime = await createRuntime(
        {
          run: RunConfigSchema.parse({}),
          pii: PiiConfigSchema.parse({ defaultAction: "tokenize" }),
          sandbox: SandboxConfigSchema.parse({
            runner: { url: `http://127.0.0.1:${String(address.port)}`, token: tokenRef },
            egress: { allow },
          }),
        },
        {
          store: new InMemoryEventStore(),
          dataDir: directory,
          transientVault: true,
          clock: new FakeClock(1_000),
          ids: new SequentialIdGenerator(),
          secretResolver: {
            resolve: (ref) => {
              expect(ref).toBe(tokenRef);
              return Promise.resolve({ reveal: () => token });
            },
          },
          policy: { version: Code.parse("e2e.web_fetch"), decide },
          model,
        },
      );
      expect(runtime.sandboxBackend).toBeInstanceOf(RemoteSandboxBackend);
      const result = await runtime.run("fetch the allowlisted page");
      const toolResult = result.events.find(
        (event) => event.type === "tool_result" && event.toolId === "web.fetch",
      );
      if (toolResult?.type !== "tool_result") {
        throw new Error("The runtime did not record the web.fetch result.");
      }
      const fileRead = result.events.find(
        (event) => event.type === "tool_result" && event.toolId === "fs.read",
      );
      if (fileRead?.type !== "tool_result") {
        throw new Error("The runtime did not record the workspace file result.");
      }
      const fileWriteIntent = result.events.find(
        (event) => event.type === "tool_intent" && event.toolId === "fs.write",
      );

      expect(result.status).toBe("completed");
      expect(model.requests[0]?.request.tools?.map(({ toolId }) => toolId)).toContain("web.fetch");
      expect(model.requests[0]?.request.tools?.map(({ toolId }) => toolId)).toEqual(
        expect.arrayContaining(["fs.read", "fs.write", "fs.edit", "fs.list", "fs.search"]),
      );
      expect(decide).toHaveBeenCalledTimes(3);
      const forwardedFetch = forwarded.find(
        (entry) => "request" in entry && "url" in entry.request,
      );
      expect(forwardedFetch).toMatchObject({
        request: { url: `http://${probeHost}:8080/runtime` },
      });
      const forwardedFileRequests = forwarded.flatMap((entry) =>
        "request" in entry && "operation" in entry.request ? [entry.request] : [],
      );
      expect(forwardedFileRequests).toEqual(
        expect.arrayContaining([
          {
            operation: "write",
            input: {
              content: "<EMAIL_1>",
              expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              mode: "create",
              path: "notes.txt",
            },
          },
          { operation: "read", input: { path: "notes.txt" } },
        ]),
      );
      expect(responses).toHaveLength(5);
      expect(responses.every(({ status }) => status === 200)).toBe(true);
      expect(WebFetchResultSchema.parse(toolResult.result)).toMatchObject({
        text: "Contact <EMAIL_2>",
        untrusted: true,
      });
      expect(FsToolResultSchema.parse(fileRead.result)).toMatchObject({
        binary: false,
        content: "<EMAIL_1>",
      });
      expect(fileWriteIntent).toMatchObject({ idempotent: true });
      expect(JSON.stringify(forwarded)).not.toContain(fileCanary);
      expect(JSON.stringify(result.events)).not.toContain(fileCanary);
      expect(JSON.stringify(current.spans)).not.toContain(fileCanary);
      expect(JSON.stringify(current.logs)).not.toContain(fileCanary);
      expect(JSON.stringify(result.events)).not.toContain("runtime.fetch@example.test");
      expect(JSON.stringify(current.spans)).not.toContain("runtime.fetch@example.test");
      expect(JSON.stringify(current.logs)).not.toContain("runtime.fetch@example.test");
    } finally {
      try {
        await runtime?.close();
      } finally {
        try {
          if (bridge.listening) {
            await new Promise<void>((resolve, reject) =>
              bridge.close((error) => {
                if (error === undefined) {
                  resolve();
                } else {
                  reject(error);
                }
              }),
            );
          }
        } finally {
          try {
            await invokeCompose([
              "--profile",
              "sandbox",
              "--profile",
              "sandbox-egress",
              "down",
              "--volumes",
              "--remove-orphans",
            ]);
          } finally {
            if (previousRunnerToken === undefined) {
              delete process.env.SANDBOX_RUNNER_TOKEN;
            } else {
              process.env.SANDBOX_RUNNER_TOKEN = previousRunnerToken;
            }
            if (previousEgressAllow === undefined) {
              delete process.env.SANDBOX_EGRESS_ALLOW;
            } else {
              process.env.SANDBOX_EGRESS_ALLOW = previousEgressAllow;
            }
            for (const [name, value] of Object.entries(previousEgressEnvironment)) {
              if (value === undefined) {
                Reflect.deleteProperty(process.env, name);
              } else {
                process.env[name] = value;
              }
            }
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    }
  }, 240_000);
});

describe("control plane", () => {
  it("requires configured HTTP authentication and serves scoped tools", async () => {
    const store = new InMemoryEventStore();
    const token = "SYNTHETIC_CONTROL_PLANE_E2E_TOKEN_LONG_ENOUGH";
    const authorization = `${String.fromCharCode(66, 101, 97, 114, 101, 114)} ${token}`;
    const server = await startControlPlaneHttp(store, 0, {
      controlPlane: ControlPlaneConfigSchema.parse({
        auth: {
          tokens: [
            {
              id: "token.readonly",
              secret: "env:CONTROL_PLANE_E2E_TOKEN",
              scopes: ["read"],
            },
          ],
        },
      }),
      secretResolver: { resolve: () => Promise.resolve({ reveal: () => token }) },
      approvalHtml: "<html>test</html>",
    });
    const client = new Client({ name: "control-plane-auth-e2e", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
      requestInit: { headers: { authorization } },
    });
    try {
      const unauthenticated = await fetch(server.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.text()).toBe("");

      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual(["get_run", "list_runs"]);
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("exposes app-only decisions and supervises a runtime cancellation through MCP", async () => {
    const store = new InMemoryEventStore();
    const runId = Id.parse("00000000000000000000000042");
    let resumeSignal: AbortSignal | undefined;
    let markResumeStarted: () => void = () => undefined;
    const resumeStarted = new Promise<void>((resolve) => {
      markResumeStarted = resolve;
    });
    const operations = {
      resumeRun: vi.fn((_runId: Id, signal: AbortSignal, onClaimed: () => void) => {
        resumeSignal = signal;
        onClaimed();
        markResumeStarted();
        return new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
      }),
      cancelRun: vi.fn(() => Promise.resolve("cancelled")),
    };
    const server = createControlPlaneServer(store, {
      isAppContext: () => true,
      operations,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "control-plane-e2e-test", version: "1.0.0" },
      {
        versionNegotiation: { mode: "auto" },
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        },
      },
    );
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools.find(({ name }) => name === "approve")?._meta).toEqual({
        ui: { visibility: ["app"] },
      });
      expect(tools.find(({ name }) => name === "deny")?._meta).toEqual({
        ui: { visibility: ["app"] },
      });

      const resumed = await client.callTool({
        name: "resume_run",
        arguments: { runId },
      });
      expect(resumed.structuredContent).toEqual({ started: true });
      await resumeStarted;
      const cancelled = await client.callTool({
        name: "cancel_run",
        arguments: { runId },
      });

      expect(cancelled.structuredContent).toEqual({ ok: true });
      expect(resumeSignal?.aborted).toBe(true);
      expect(operations.resumeRun).toHaveBeenCalledOnce();
      expect(operations.cancelRun).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
      await clientTransport.close();
      await serverTransport.close();
      await store.close();
    }
  });

  it("starts a tokenized run through MCP with requester attribution and a metadata-only result", async () => {
    const store = new InMemoryEventStore();
    const model = new FakeModelPort([completion([], "Synthetic completion")]);
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        pii: PiiConfigSchema.parse({ defaultAction: "tokenize" }),
      },
      {
        store,
        transientVault: true,
        clock: new FakeClock(1_000),
        ids: new SequentialIdGenerator(),
        model,
      },
    );
    const server = createControlPlaneServer(runtime.store, {
      controlPlane: ControlPlaneConfigSchema.parse({ allowAgentStartedRuns: true }),
      isAppContext: () => true,
      operations: createControlPlaneOperations(runtime),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "control-plane-start-e2e", version: "1.0.0" });
    const contentCanary = "control-plane-e2e@example.test";
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "start_run",
        arguments: { goal: `Contact ${contentCanary}` },
      });
      const output = JSON.stringify(result);
      const structured = startRunOutputSchema.parse(result.structuredContent);
      expect(structured).toMatchObject({ status: "pending" });
      expect(output).not.toContain(contentCanary);
      if ("code" in structured) {
        throw new Error("The start_run tool returned a coded failure.");
      }
      const events = await readEvents(runtime.store, structured.runId);
      const created = events[0];
      const input = events.find((event) => event.type === "run_input");
      expect(created).toMatchObject({ type: "run_created", requestedBy: "token.local" });
      expect(JSON.stringify(input)).not.toContain(contentCanary);
      expect(JSON.stringify(input)).toContain("<");
    } finally {
      await client.close();
      await server.close();
      await clientTransport.close();
      await serverTransport.close();
      await runtime.close();
    }
  });
});

describe("retention", () => {
  it("uses the CLI to inspect pending migrations and purge the completed run", async () => {
    const current = fixture();
    const runId = current.runId;
    if (runId === undefined) {
      throw new Error("The run id is not available.");
    }
    current.clock.advance(2 * DAY_MS);
    const snapshotDirectory = join(current.dataDirectory, "snapshots", runId);
    const snapshotStore = new SqliteEventStore(current.eventStorePath);
    try {
      const latest = await snapshotStore.latestSnapshot(runId);
      expect(latest?.workspaceRef).toBeDefined();
      const checkpointEvent = (await readEvents(snapshotStore, runId)).findLast(
        (event) => event.type === "checkpoint_written",
      );
      const eventWorkspaceRef =
        checkpointEvent?.type === "checkpoint_written" ? checkpointEvent.workspaceRef : undefined;
      expect(eventWorkspaceRef).toEqual(latest?.workspaceRef);
      expect(await readdir(snapshotDirectory)).not.toHaveLength(0);
    } finally {
      await snapshotStore.close();
    }
    const databaseFilesBeforeDryRuns = await readdir(current.dataDirectory);
    const databaseBeforeDryRuns = await readFile(current.eventStorePath);
    const migration = await invokeCli(["--json", "store", "migrate", "--dry-run"]);
    expect(migration.code).toBe(ExitCode.ok);
    expect(jsonResult(StoreMigrateResultSchema, migration.stdout)).toEqual({
      applied: [],
      pending: [],
    });
    expect(await readFile(current.eventStorePath)).toEqual(databaseBeforeDryRuns);
    expect(await readdir(current.dataDirectory)).toEqual(databaseFilesBeforeDryRuns);
    expect(await readdir(snapshotDirectory)).not.toHaveLength(0);

    const dryRun = await invokeCli(["--json", "store", "purge", "--dry-run"]);
    expect(dryRun.stderr).toEqual([]);
    expect(dryRun.code).toBe(ExitCode.ok);
    expect(jsonResult(StorePurgeResultSchema, dryRun.stdout)).toMatchObject({ purged: 1 });
    expect(await readFile(current.eventStorePath)).toEqual(databaseBeforeDryRuns);
    expect(await readdir(current.dataDirectory)).toEqual(databaseFilesBeforeDryRuns);

    const purge = await invokeCli(["--json", "store", "purge"]);
    expect(purge.code).toBe(ExitCode.ok);
    expect(jsonResult(StorePurgeResultSchema, purge.stdout)).toMatchObject({
      examined: 2,
      purged: 1,
      skippedActive: 1,
      hookFailures: 0,
    });
    await expect(readdir(snapshotDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const store = new SqliteEventStore(current.eventStorePath);
    try {
      expect(await store.head(runId)).toBe(0);
    } finally {
      await store.close();
    }

    const runtime = await createRuntime(await current.context.loadConfig(), {
      dataDir: current.dataDirectory,
      clock: current.clock,
      ids: current.ids,
      roleConfigDirectory: current.directory,
      secretResolver: new CompositeSecretResolver(),
      sandboxBackend: unusedSandboxBackend,
    });
    try {
      await expect(
        runtime.vault.resolve(runId, Token.parse("<EMAIL_1>"), { boundary: "ui" }),
      ).resolves.toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("restores the latest checkpoint workspace after a run restart", async () => {
    const current = fixture();
    const config = await current.context.loadConfig();
    const toolId = Code.parse("snapshot.probe");
    const fileContent = "synthetic workspace snapshot canary";
    let finishFirstModel: ((value: ModelCompletion) => void) | undefined;
    let signalFirstModelStarted: (() => void) | undefined;
    const firstModelStarted = new Promise<void>((resolve) => {
      signalFirstModelStarted = resolve;
    });
    let modelCalls = 0;
    const model: ModelPort = {
      complete: () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return new Promise((resolve) => {
            finishFirstModel = resolve;
            signalFirstModelStarted?.();
          });
        }
        return Promise.resolve(completion([], "resumed"));
      },
    };
    let restoredContent: string | undefined;
    let toolRunId: Id | undefined;
    const tool: ToolPort = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: async () => {
        if (toolRunId === undefined) {
          throw new Error("The run id is unavailable to the test tool.");
        }
        restoredContent = await readFile(
          join(current.dataDirectory, "workspaces", toolRunId, "project", "checkpoint.txt"),
          "utf8",
        );
        return { outcome: "ok", result: { restored: true } };
      },
    };
    const policy: PolicyPort = {
      version: Code.parse("snapshot_test_policy"),
      decide: () => ({
        decision: "ask",
        ruleId: Code.parse("snapshot_test_rule"),
        reason: Code.parse("snapshot_test_approval"),
        editable: [],
      }),
    };
    const runtime = await createRuntime(config, {
      dataDir: current.dataDirectory,
      clock: current.clock,
      ids: current.ids,
      model,
      policy,
      store: new InMemoryEventStore(),
      sandboxBackend: unusedSandboxBackend,
      tool,
      secretResolver: new CompositeSecretResolver(),
    });
    try {
      const execution = runtime.start("snapshot resume");
      toolRunId = execution.runId;
      await execution.started;
      await firstModelStarted;
      const workspaceFile = join(
        current.dataDirectory,
        "workspaces",
        execution.runId,
        "project",
        "checkpoint.txt",
      );
      await mkdir(join(current.dataDirectory, "workspaces", execution.runId, "project"), {
        recursive: true,
      });
      await writeFile(workspaceFile, fileContent);
      const releaseModel = finishFirstModel;
      if (releaseModel === undefined) {
        throw new Error("The first model call did not start.");
      }
      releaseModel(
        completion(
          [
            {
              callId: Id.parse("00000000000000000000000021"),
              toolId,
              args: {},
            },
          ],
          "awaiting approval",
        ),
      );
      const suspended = await execution.completion;
      const approvalId = suspended.approvalIds[0];
      if (approvalId === undefined) {
        throw new Error("The run did not request approval.");
      }
      const checkpoint = await runtime.store.latestSnapshot(execution.runId);
      expect(checkpoint?.workspaceRef).toBeDefined();
      await runtime.resolveApproval(execution.runId, approvalId, "approve", {
        metadata: { decidedBy: "human", approverId: "cli.test" },
      });
      await rm(join(current.dataDirectory, "workspaces", execution.runId), {
        recursive: true,
        force: true,
      });

      const resumed = await runtime.resume(execution.runId);
      expect(resumed.status).toBe("completed");
      expect(restoredContent).toBe(fileContent);
    } finally {
      await runtime.close();
    }
  });
});

describe("SDK", () => {
  it("starts, watches, and reads a run through the public SDK runtime", async () => {
    const current = fixture();
    const config = await current.context.loadConfig();
    const harness = await createHarness({
      config: HarnessConfigSchema.parse({
        ...config,
        sandbox: {},
        policy: { ...config.policy, file: join(current.directory, "policy.yaml") },
      }),
      overrides: {
        clock: current.clock,
        ids: current.ids,
        model: new FakeModelPort([completion([], "Synthetic SDK completion")]),
        secretResolver: new CompositeSecretResolver(),
      },
    });

    try {
      const { runId } = await harness.startRun({ goal: "Synthetic SDK end-to-end run" });
      const statuses: string[] = [];
      for await (const event of harness.watch(runId, { fromSeq: 0 })) {
        if (event.kind === "run_status") {
          statuses.push(event.to);
          if (event.to === "completed" || event.to === "failed" || event.to === "cancelled") {
            break;
          }
        }
      }

      expect(statuses).toContain("completed");
      await expect(harness.getRun(runId)).resolves.toMatchObject({
        runId,
        status: "completed",
      });
    } finally {
      await harness.close();
    }
  });
});

describe("invariants", () => {
  it("keeps the canary out of telemetry, CLI output, and log captures", async () => {
    const current = fixture();
    await current.telemetry.tracerProvider.forceFlush();
    await current.telemetry.loggerProvider.forceFlush();
    expect(current.spans.length).toBeGreaterThan(0);
    expect(current.logs.length).toBeGreaterThan(0);

    for (const span of current.spans) {
      expect(JSON.stringify(span)).not.toContain(current.canary);
      const definition = listSpanDefinitions().find(({ name }) => name === span.name);
      expect(definition).toBeDefined();
      for (const [name, value] of Object.entries(span.attributes)) {
        expect(Object.keys(definition?.shape ?? {})).toContain(name);
        expect(["string", "number", "boolean"]).toContain(typeof value);
      }
    }
    const logDefinitions = new Map(
      listLogDefinitions().map((definition) => [definition.name, definition]),
    );
    for (const record of current.logs) {
      expect(JSON.stringify(record)).not.toContain(current.canary);
      const eventName = record.eventName;
      const definition = eventName === undefined ? undefined : logDefinitions.get(eventName);
      expect(definition).toBeDefined();
      for (const [name, value] of Object.entries(record.attributes)) {
        expect(Object.keys(definition?.shape ?? {})).toContain(name);
        expect(["string", "number", "boolean"]).toContain(typeof value);
      }
    }
    expect(JSON.stringify(current.stdout)).not.toContain(current.canary);
    expect(JSON.stringify(current.stderr)).not.toContain(current.canary);
  });

  it("does not expose the synthetic canary in approval list or show output", () => {
    const current = fixture();
    expect(current.approvalOutput.join("")).not.toContain(current.canary);
  });

  it("does not expose the synthetic canary in tool-call events", () => {
    const current = fixture();
    expect(current.toolCallEvents).toBeDefined();
    expect(JSON.stringify(current.toolCallEvents)).not.toContain(current.canary);
  });

  it("re-sanitizes a local-allow model input before hosted fallback", async () => {
    const canary = "e2e-model-input-canary@example.test";
    const localRequests: ModelRequest[] = [];
    const hostedRequests: ModelRequest[] = [];
    const models = ModelsConfigSchema.parse({
      retry: { maxAttempts: 1 },
      providers: [
        {
          id: "local",
          kind: "openai_compatible",
          baseUrl: "http://127.0.0.1:1234",
          trust: "local",
        },
        { id: "hosted", kind: "openai", trust: "hosted" },
      ],
      routing: {
        default: [
          { provider: "local", model: "local-model" },
          { provider: "hosted", model: "hosted-model" },
        ],
      },
    });
    const pii = PiiConfigSchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["local"],
          action: "allow",
        },
      ],
    });
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        keys: KeysConfigSchema.parse({
          currentKeyId: "model-input-test",
          keys: [{ id: "model-input-test", secret: KEY_REF }],
        }),
        pii,
        models,
      },
      {
        store: new InMemoryEventStore(),
        transientVault: true,
        sandboxBackend: unusedSandboxBackend,
        policy: {
          version: Code.parse("test_policy"),
          decide: () => ({
            decision: "allow",
            ruleId: Code.parse("test_allow"),
            reason: Code.parse("test_allowed"),
            editable: [],
          }),
        },
        providerAdapters: [
          {
            provider: "local",
            kind: "openai",
            complete: (request) => {
              localRequests.push(request);
              return Promise.reject(new ProviderError("provider_unavailable"));
            },
          },
          {
            provider: "hosted",
            kind: "openai",
            complete: (request) => {
              hostedRequests.push(request);
              return Promise.resolve({
                parts: [{ type: "text", text: "completed" }],
                usage: { inputTokens: 1, outputTokens: 1 },
                finishReason: "stop",
                latencyMs: 0,
              });
            },
          },
        ] satisfies ProviderAdapter[],
        secretResolver: {
          resolve: () => Promise.resolve({ reveal: () => Buffer.alloc(32, 31).toString("base64") }),
        },
      },
    );

    try {
      const result = await runtime.run(canary);

      expect(result.status).toBe("completed");
      expect(JSON.stringify(localRequests[0]?.messages)).toContain(canary);
      expect(JSON.stringify(hostedRequests[0]?.messages)).not.toContain(canary);
      expect(JSON.stringify(hostedRequests[0]?.messages)).toContain("<EMAIL_1>");
      const runId = result.events[0]?.runId;
      expect(runId).toBeDefined();
      if (runId === undefined) {
        throw new Error("Expected the run to have an ID.");
      }
      const persistedEvents: Event[] = [];
      for await (const event of runtime.store.read(runId)) {
        persistedEvents.push(event);
      }
      expect(JSON.stringify(persistedEvents)).not.toContain(canary);
    } finally {
      await runtime.close();
    }
  });

  it("does not persist the synthetic canary in SQLite event-store content bytes", () => {
    const current = fixture();
    expect(current.eventStoreBytes).toBeDefined();
    const bytes = Buffer.from(current.eventStoreBytes ?? new Uint8Array()).toString("utf8");
    expect(bytes).not.toContain(current.canary);
  });

  it("does not persist the synthetic canary in SQLite snapshot content bytes", () => {
    const current = fixture();
    expect(current.snapshotBytes).toBeDefined();
    const bytes = Buffer.from(current.snapshotBytes ?? new Uint8Array()).toString("utf8");
    expect(bytes).not.toContain(current.canary);
  });

  it("proves the canary assertion detects a planted leak", () => {
    const canary = fixture().canary;
    const assertCanaryAbsent = (captures: readonly string[]): void => {
      expect(captures.join("")).not.toContain(canary);
    };
    expect(() => {
      assertCanaryAbsent([`synthetic log: ${canary}`]);
    }).toThrow();
  });
});
