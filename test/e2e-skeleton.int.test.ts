// SPDX-License-Identifier: Apache-2.0
// Every task that wires a capability into the runtime or CLI extends this test.
// Not wired yet: approval escalation WebhookNotifier (17.6 -> #125)
// Not wired yet: RemoteSandboxBackend / sandbox.runner (19.3 -> #94)
// Not wired yet: vault purge hook (12.6 -> #108)
// Not wired yet: Postgres vault adapter (12.9 -> #140)
// Not wired yet: approvals --reveal (17.10 -> #373)
// Not wired yet: production tool port (MCP 6.5 -> #199)
// Not wired yet: runtime vault from config (13.12 -> #389)
// Not wired yet: storage-boundary tokenization (13.8 -> #81)
// Not wired yet: sentinel trip gate wired to the runtime vault (8.4 -> #74)
import { Command } from "commander";
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
import { CompositeSecretResolver } from "@harness/config";
import { createRuntime, type ModelCompletion, type ToolPort } from "@harness/core";
import { FakeModelPort } from "@harness/core/testing";
import {
  ApprovalListResultSchema,
  ApprovalShowResultSchema,
  Code,
  FakeClock,
  Id,
  RunResultSchema,
  SequentialIdGenerator,
  StoreMigrateResultSchema,
  StorePurgeResultSchema,
  parseJson,
} from "@harness/schemas";
import { SqliteEventStore } from "@harness/store";
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
import type { JsonValue, Event } from "@harness/schemas";
import type { z } from "zod";
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
        { callId: id(11), toolId: ASK_TOOL, args: { email: canary } },
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
    expect(loaded.store.retention).toEqual({ completedRunsDays: 1, failedRunsDays: 1 });
    expect(await readFile(current.configPath, "utf8")).not.toContain(current.canary);
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

    const approved = await invokeCli(["--json", "approvals", "approve", approvalId, "--yes"]);
    expect(approved.code).toBe(ExitCode.ok);
    expect(current.callsAfterApproval).toEqual([]);
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
    expect(current.argsAfterApproval).toEqual([{ email: current.canary }]);

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
      examined: 1,
      purged: 1,
      skippedActive: 0,
      hookFailures: 0,
    });

    const store = new SqliteEventStore(current.eventStorePath);
    try {
      expect(await store.head(runId)).toBe(0);
    } finally {
      await store.close();
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
