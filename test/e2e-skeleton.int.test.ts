// SPDX-License-Identifier: Apache-2.0
// Every task that wires a capability into the runtime or CLI extends this test.
// Not wired yet: approval escalation WebhookNotifier (17.6 -> #125)
// Not wired yet: RemoteSandboxBackend / sandbox.runner (19.3 -> #94)
// Not wired yet: Postgres vault adapter (12.9 -> #140)
// Not wired yet: production tool port (MCP 6.5 -> #199)
// Not wired yet: reference host in core runtime/CLI (3.6 -> #187)
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
import { CompositeSecretResolver, EnvSecretResolver, FileSecretResolver } from "@harness/config";
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
import { buildApprovalPayload } from "@harness/policy";
import {
  ApprovalListResultSchema,
  ApprovalShowResultSchema,
  FakeClock,
  Id,
  JsonValue,
  RunResultSchema,
  SequentialIdGenerator,
  StoreMigrateResultSchema,
  StorePurgeResultSchema,
  parseJson,
} from "@harness/schemas";
import { SqliteEventStore } from "@harness/store";
import { LocalKeyProvider, SqliteVault } from "@harness/vault";
import {
  attr,
  createTelemetrySdk,
  defineLogRecord,
  listLogDefinitions,
  listSpanDefinitions,
  type TelemetrySdkOptions,
} from "@harness/telemetry";
import type { Event } from "@harness/schemas";
import type { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
      expect(events.at(-1)).toMatchObject({ type: "run_status_changed", to: "completed" });
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
