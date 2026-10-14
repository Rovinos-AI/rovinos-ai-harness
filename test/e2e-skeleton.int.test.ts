// SPDX-License-Identifier: Apache-2.0
// Every task that wires a capability into the runtime or CLI extends this test.
// Not wired yet: approval escalation WebhookNotifier (17.6 -> #125)
// Not wired yet: RemoteSandboxBackend / sandbox.runner (19.3 -> #94)
// Not wired yet: Postgres vault adapter (12.9 -> #140)
// Not wired yet: MCP registry and model-visible descriptions through model-input PII (-> #199, model-input PII 13.6 -> #150)
// Not wired yet: production tool port (MCP 6.5 -> #199)
// Not wired yet: control-plane network listener behind the TLS proxy (18.5 -> #178)
// Not wired yet: reference host in core runtime/CLI (-> #207)
// Not wired yet: runtime vault from config (13.12 -> #389)
// Not wired yet: storage-boundary tokenization (13.8 -> #81)
// Not wired yet: SDK and control-plane consumers of store watch/watchRuns (#230, 24.1)
// Not wired yet: sentinel trip gate wired to the runtime vault (8.4 -> #74)
// Not wired yet: reference-host app content callbacks in the core runtime/CLI (-> #207)
import { Command } from "commander";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { ExportResultCode } from "@opentelemetry/core";
import Database from "better-sqlite3";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultContext,
  createOutput,
  ExitCode,
  main,
  type CliContext,
} from "@harness/cli/programmatic";
import { createControlPlaneServer } from "@harness/control-plane";
import {
  CompositeSecretResolver,
  EnvSecretResolver,
  FileSecretResolver,
  loadConfig,
} from "@harness/config";
import {
  Checkpointer,
  createRuntime,
  foldRunState,
  NaiveContext,
  requestApproval,
  RunRecorder,
  RUN_SPAN,
  type ModelCompletion,
  type ToolPort,
} from "@harness/core";
import { FakeModelPort } from "@harness/core/testing";
import { InMemoryEventStore, SqliteEventStore } from "@harness/store";
import { buildApprovalPayload } from "@harness/policy";
import {
  ApprovalListResultSchema,
  ApprovalShowResultSchema,
  Code,
  FakeClock,
  Id,
  JsonValue,
  RunResultSchema,
  SequentialIdGenerator,
  StoreMigrateResultSchema,
  StorePurgeResultSchema,
  parseJson,
} from "@harness/schemas";
import { LocalKeyProvider, SqliteVault, Token } from "@harness/vault";
import {
  attr,
  createTelemetrySdk,
  defineLogRecord,
  defineSpan,
  listLogDefinitions,
  listSpanDefinitions,
  SentinelGate,
  type TelemetrySdkOptions,
  VaultRunView,
  withSpan,
} from "@harness/telemetry";
import type { Event } from "@harness/schemas";
import type { z } from "zod";
import { createSandboxComposeInvocation } from "../scripts/compose/sandbox.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DAY_MS = 86_400_000;
const KEY_REF = "env:HARNESS_E2E_KEY";
const KEY_ID = "e2e-test";
const ALLOW_TOOL = "update_plan";
const ASK_TOOL = "synthetic.ask";
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

async function readEvents(store: SqliteEventStore, runId: Id) {
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

function jsonResult<Schema extends z.ZodType>(
  schema: Schema,
  output: readonly string[],
): z.infer<Schema> {
  return parseJson(schema, output.join("").trim());
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
    { taskId: "8.4", packageName: "@harness/telemetry" },
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
      { maxPrepareMs: 1_000 },
    ),
    telemetry: { sentinel: { minValueLength: 6, enabled: true } },
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
  const logger = logs.getLogger("@harness/telemetry");
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
    expect(loaded.vault).toEqual({ purgeAfterDays: 7 });
    expect(loaded.store.retention).toEqual({ completedRunsDays: 1, failedRunsDays: 1 });
    expect(await readFile(current.configPath, "utf8")).not.toContain(current.canary);
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

describe("approval", () => {
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
  it("executes the ask tool only after recording approval and completes the run", async () => {
    const current = fixture();
    const runId = current.runId;
    if (runId === undefined) {
      throw new Error("The run id is not available.");
    }
    current.sentinelProbe.enabled = true;
    const result = await invokeCli(["--json", "resume", runId]);
    expect(result.code).toBe(ExitCode.ok);
    expect(jsonResult(RunResultSchema, result.stdout).status).toBe("completed");
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
});

describe("control plane", () => {
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
});

describe("retention", () => {
  it("uses the CLI to inspect pending migrations and purge the completed run", async () => {
    const current = fixture();
    const runId = current.runId;
    if (runId === undefined) {
      throw new Error("The run id is not available.");
    }
    current.clock.advance(2 * DAY_MS);
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
    });
    try {
      await expect(
        runtime.vault.resolve(runId, Token.parse("<EMAIL_1>"), { boundary: "ui" }),
      ).resolves.toBeUndefined();
    } finally {
      await runtime.close();
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

  // Not wired yet: model-input boundary (13.6 -> #150)
  it.fails("does not send the synthetic canary in model requests", () => {
    const current = fixture();
    expect(JSON.stringify(current.model.requests)).not.toContain(current.canary);
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
