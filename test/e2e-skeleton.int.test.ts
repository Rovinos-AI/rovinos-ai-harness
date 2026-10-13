// SPDX-License-Identifier: Apache-2.0
// Every task that wires a capability into the runtime or CLI extends this test.
// Not wired yet: approval escalation WebhookNotifier (17.6 -> #125)
// Not wired yet: RemoteSandboxBackend / sandbox.runner (19.3 -> #94)
// Not wired yet: harness store migrate / store purge (20.6 -> #386)
// Not wired yet: vault purge hook (12.6 -> #108)
// Not wired yet: approvals --reveal (20.6 -> #373)
// Not wired yet: production tool port (MCP 6.5 -> #199)
// Not wired yet: storage-boundary tokenization (13.8 -> #81)
import { Command } from "commander";
import { trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { ExportResultCode } from "@opentelemetry/core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultContext, main } from "../packages/cli/src/main.js";
import type { CliContext } from "../packages/cli/src/command.js";
import { ExitCode } from "../packages/cli/src/exit-codes.js";
import { createOutput } from "../packages/cli/src/output.js";
import { type ModelCompletion, type ToolPort } from "@harness/core";
import { FakeModelPort } from "@harness/core/testing";
import {
  ApprovalListResultSchema,
  ApprovalShowResultSchema,
  FakeClock,
  Id,
  KeysConfigSchema,
  RunResultSchema,
  SequentialIdGenerator,
  StoreRetentionConfigSchema,
  parseJson,
} from "@harness/schemas";
import { SqliteEventStore, purgeExpiredRuns } from "@harness/store";
import { emailDetector, PiiToolPort, Tokenizer } from "@harness/pii";
import {
  attr,
  createTelemetrySdk,
  defineLogRecord,
  listLogDefinitions,
  listSpanDefinitions,
  type TelemetrySdkOptions,
} from "@harness/telemetry";
import { LocalKeyProvider, SqliteVault, AuditingVaultResolver } from "@harness/vault";
import type { KeySecretResolver } from "@harness/vault";
import type { JsonValue, Event } from "@harness/schemas";
import type { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DAY_MS = 86_400_000;
const KEY_REF = "env:HARNESS_E2E_KEY";
const KEY_ID = "e2e-test";
const ALLOW_TOOL = "synthetic.allow";
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
  readonly vaultPath: string;
  readonly canary: string;
  readonly clock: FakeClock;
  readonly ids: SequentialIdGenerator;
  readonly model: FakeModelPort;
  readonly callsBeforeApproval: string[];
  readonly callsAfterApproval: string[];
  readonly stdout: string[];
  readonly stderr: string[];
  readonly context: CliContext;
  readonly spans: ExportedSpan[];
  readonly logs: ExportedLogRecord[];
  readonly telemetry: ReturnType<typeof createTelemetrySdk>;
  readonly vault: SqliteVault;
  runId?: Id;
  approvalId?: Id;
  eventStoreBytes?: Uint8Array;
  snapshotWritten?: boolean;
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

function syntheticTools(callsBeforeApproval: string[], callsAfterApproval: string[]): ToolPort {
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
      }
      return Promise.resolve({ outcome: "ok", result: { ok: true } });
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

async function invokeCli(args: readonly string[]): Promise<CliCapture> {
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
  const createDefaultRuntime = cliContext.createRuntime?.bind(cliContext);
  if (createDefaultRuntime === undefined) {
    throw new Error("The CLI default runtime factory is unavailable.");
  }
  cliContext.createRuntime = (config, overrides) => {
    const baseTool = syntheticTools(current.callsBeforeApproval, current.callsAfterApproval);
    const tool = new PiiToolPort(baseTool, {
      tokenizer: new Tokenizer({
        vault: current.vault,
        policy: config.pii,
        detectors: { detect: (text) => emailDetector.detect(text) },
      }),
      config: config.pii,
      resolver: new AuditingVaultResolver(current.vault, () => undefined),
    });
    return createDefaultRuntime(config, {
      ...overrides,
      clock: current.clock,
      ids: current.ids,
      model: overrides?.model ?? current.model,
      tool,
    });
  };
  const code = await main(args, cliContext);
  current.stdout.push(...stdout);
  current.stderr.push(...stderr);
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
  const vaultPath = join(directory, "vault.sqlite");
  const canary = `canary.${directory.split("/").at(-1) ?? "fixture"}@example.test`;
  const key = Buffer.alloc(32, 29).toString("base64");
  previousConfig = process.env.HARNESS_CONFIG;
  previousDataDirectory = process.env.HARNESS_DATA_DIR;
  previousKey = process.env.HARNESS_E2E_KEY;
  process.env.HARNESS_CONFIG = configPath;
  process.env.HARNESS_DATA_DIR = dataDirectory;
  process.env.HARNESS_E2E_KEY = key;
  const keyConfig = {
    currentKeyId: KEY_ID,
    keys: [{ id: KEY_ID, secret: KEY_REF }],
  };
  const keySecretResolver: KeySecretResolver = {
    resolve: () => Promise.resolve({ reveal: () => key }),
  };
  const vaultKeyProvider = new LocalKeyProvider({
    config: KeysConfigSchema.parse(keyConfig),
    secretResolver: keySecretResolver,
    onWarning: () => undefined,
  });
  const vault = new SqliteVault(vaultPath, vaultKeyProvider, () => 1_000);
  const spans: ExportedSpan[] = [];
  const records: ExportedLogRecord[] = [];
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
    telemetry: { sentinel: { minValueLength: 6, enabled: false } },
  });
  trace.setGlobalTracerProvider(telemetry.tracerProvider);
  logs.setGlobalLoggerProvider(telemetry.loggerProvider);
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
        { callId: id(10), toolId: ALLOW_TOOL, args: { value: "synthetic" } },
        { callId: id(11), toolId: ASK_TOOL, args: { email: canary } },
      ],
      "awaiting approval",
    ),
    completion([], "completed"),
  ]);
  const clock = new FakeClock(1_000);
  const ids = new SequentialIdGenerator();
  const callsBeforeApproval: string[] = [];
  const callsAfterApproval: string[] = [];
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
    vaultPath,
    canary,
    clock,
    ids,
    model,
    callsBeforeApproval,
    callsAfterApproval,
    stdout: [],
    stderr: [],
    context: createDefaultContext(new Command(), createOutput()),
    spans,
    logs: records,
    telemetry,
    vault,
  };
});

afterAll(async () => {
  const current = skeleton;
  if (current !== undefined) {
    current.vault.close();
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
      current.snapshotWritten = checkpoint !== undefined;
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
    const list = await invokeCli(["--json", "approvals", "list"]);
    expect(list.code).toBe(ExitCode.ok);
    const listed = jsonResult(ApprovalListResultSchema, list.stdout);
    expect(listed.approvals).toHaveLength(1);
    expect(listed.approvals[0]?.approvalId).toBe(approvalId);

    const show = await invokeCli(["--json", "approvals", "show", approvalId, "--show-args"]);
    expect(show.code).toBe(ExitCode.ok);
    const displayed = jsonResult(ApprovalShowResultSchema, show.stdout);
    expect(JSON.stringify(displayed.args)).toContain("<EMAIL_1>");
    expect(JSON.stringify({ ...list, ...show })).not.toContain(current.canary);
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
    const result = await invokeCli(["--json", "resume", runId]);
    expect(result.code).toBe(ExitCode.ok);
    expect(jsonResult(RunResultSchema, result.stdout).status).toBe("completed");
    expect(current.callsAfterApproval).toEqual([ASK_TOOL]);

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
      expect(events.at(-1)).toMatchObject({ type: "run_status_changed", to: "completed" });
      current.eventStoreBytes = await readFile(current.eventStorePath);
      current.snapshotWritten = (await store.latestSnapshot(runId)) !== undefined;
    } finally {
      await store.close();
    }
  });
});

describe("retention", () => {
  it("purges the completed run after its configured retention window", async () => {
    const current = fixture();
    const runId = current.runId;
    if (runId === undefined) {
      throw new Error("The run id is not available.");
    }
    current.clock.advance(2 * DAY_MS);
    const store = new SqliteEventStore(current.eventStorePath);
    try {
      const result = await purgeExpiredRuns({
        store,
        clock: current.clock,
        policy: StoreRetentionConfigSchema.parse({
          completedRunsDays: 1,
          failedRunsDays: 1,
        }),
        dryRun: false,
      });
      expect(result.purged).toBe(1);
      expect(await store.head(runId)).toBe(0);
    } finally {
      await store.close();
    }
  });
});

describe("invariants", () => {
  it("keeps the canary out of telemetry, CLI output, and plaintext vault storage", async () => {
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
    const runId = current.runId;
    if (runId === undefined) {
      throw new Error("The run id is not available.");
    }
    expect(await current.vault.listRawValues(runId)).toContain(current.canary);
    expect((await readFile(current.vaultPath)).includes(Buffer.from(current.canary, "utf8"))).toBe(
      false,
    );
  });

  // Not wired yet: storage-boundary tokenization (13.8 -> #81)
  it.fails("does not persist the synthetic canary in SQLite event-store bytes", () => {
    const current = fixture();
    expect(current.eventStoreBytes).toBeDefined();
    const bytes = Buffer.from(current.eventStoreBytes ?? new Uint8Array()).toString("utf8");
    expect(bytes).not.toContain(current.canary);
  });

  // Not wired yet: storage-boundary tokenization (13.8 -> #81)
  it.fails("does not persist the synthetic canary in SQLite snapshot bytes", () => {
    const current = fixture();
    expect(current.snapshotWritten).toBe(true);
    const snapshotBytes = current.eventStoreBytes;
    expect(snapshotBytes).toBeDefined();
    const bytes = Buffer.from(snapshotBytes ?? new Uint8Array()).toString("utf8");
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
