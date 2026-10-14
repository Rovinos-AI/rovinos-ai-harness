// SPDX-License-Identifier: Apache-2.0
import { loadConfig } from "@harness/config";
import { InMemoryWorkspace, OffloadingToolPort, type WorkspacePort } from "@harness/context";
import { createRuntime } from "@harness/core";
import type { Runtime, ToolPort } from "@harness/core";
import { FileCassetteStore } from "@harness/models";
import { Code, Id, Sha256Hex, SequentialIdGenerator } from "@harness/schemas";
import type { Event } from "@harness/schemas";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCanaries, type CanarySet } from "./canaries.js";
import { captureCliOutput } from "./cli-output.js";
import { readDatabaseSinks } from "./scanning.js";
import {
  ASK_TOOL,
  createCanaryModel,
  createCanarySecretResolver,
  createCanaryToolPort,
  ECHO_TOOL,
  FAIL_TOOL,
  RuntimeVaultReader,
  TEST_KEY_REF,
} from "./runtime-fixture.js";
import {
  captureWithoutSentinel,
  createCanaryTelemetry,
  emitCanaryBadLog,
  emitCanaryKeysRotated,
  emitCanaryUnsafeSpan,
  type CanaryTelemetry,
} from "./telemetry.js";

interface CapturedSinks {
  readonly spans: CanaryTelemetry["spans"];
  readonly logs: CanaryTelemetry["logs"];
  readonly stdout: string[];
  readonly stderr: string[];
  readonly inspect: string[];
  readonly context: string[];
  readonly approvals: string[];
  readonly snapshot: string[];
  readonly workspace: Map<string, Uint8Array>;
  readonly cassette: string[];
  readonly toolBoundary: string[];
  readonly toolErrors: string[];
  readonly unprotectedExporter: string[];
}

async function loadCanaryConfig(
  directory: string,
): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const configPath = join(directory, "harness.yaml");
  const policy = [
    "version: 1",
    "defaultDecision: deny",
    "rules:",
    "  - id: canary_tool_allow",
    "    match:",
    `      tools: [${ECHO_TOOL}, ${FAIL_TOOL}]`,
    "    decision: allow",
    "    reason: canary_allowed",
    "  - id: canary_tool_ask",
    "    match:",
    `      tools: [${ASK_TOOL}]`,
    "    decision: ask",
    "    reason: canary_approval",
    "",
  ].join("\n");
  const source = [
    "run: {}",
    "keys:",
    "  currentKeyId: canary-test-key",
    "  keys:",
    "    - id: canary-test-key",
    `      secret: ${TEST_KEY_REF}`,
    "policy:",
    "  file: policy.yaml",
    "pii:",
    "  defaultAction: tokenize",
    "  detokenize:",
    `    - toolId: ${ECHO_TOOL}`,
    "      args: [/value]",
    `    - toolId: ${FAIL_TOOL}`,
    "      args: [/value]",
    "  custom:",
    "    - name: canary_api_key",
    "      pattern: 'hsk_live_[a-f0-9]{24}'",
    "    - name: canary_person",
    "      pattern: '[A-Z][a-z]{2,9}-[a-f0-9]{8}'",
    "",
  ].join("\n");
  await writeFile(join(directory, "policy.yaml"), policy, "utf8");
  await writeFile(configPath, source, "utf8");
  return loadConfig({ configPath });
}

/** Compose the shipped runtime around synthetic ports and capture its real durable sinks. */
export class CanaryHarness {
  readonly canaries: CanarySet;
  readonly captured: CapturedSinks;
  readonly eventDatabasePath: string;
  readonly vaultDatabasePath: string;
  readonly executedTools: string[];
  readonly workspace: WorkspacePort;

  private readonly directory: string;
  private readonly runtimeConfig: Awaited<ReturnType<typeof loadConfig>>;
  private readonly runtime: Runtime;
  private readonly telemetry: CanaryTelemetry;
  private readonly reader: RuntimeVaultReader;
  private readonly ids: SequentialIdGenerator;
  private readonly clock: { now(): number };
  private readonly memoryWorkspace = new InMemoryWorkspace();
  runId: Id | undefined;

  private constructor(input: {
    readonly canaries: CanarySet;
    readonly directory: string;
    readonly runtimeConfig: Awaited<ReturnType<typeof loadConfig>>;
    readonly runtime: Runtime;
    readonly telemetry: CanaryTelemetry;
    readonly reader: RuntimeVaultReader;
    readonly ids: SequentialIdGenerator;
    readonly clock: { now(): number };
    readonly executedTools: string[];
    readonly toolBoundary: string[];
    readonly toolErrors: string[];
  }) {
    this.canaries = input.canaries;
    this.directory = input.directory;
    this.runtimeConfig = input.runtimeConfig;
    this.runtime = input.runtime;
    this.telemetry = input.telemetry;
    this.reader = input.reader;
    this.ids = input.ids;
    this.clock = input.clock;
    this.executedTools = input.executedTools;
    this.eventDatabasePath = join(input.directory, "harness.db");
    this.vaultDatabasePath = join(input.directory, "vault.db");
    this.captured = {
      spans: input.telemetry.spans,
      logs: input.telemetry.logs,
      stdout: [],
      stderr: [],
      inspect: [],
      context: [],
      approvals: [],
      snapshot: [],
      workspace: new Map(),
      cassette: [],
      toolBoundary: input.toolBoundary,
      toolErrors: input.toolErrors,
      unprotectedExporter: [],
    };
    this.workspace = {
      write: async (path, data) => {
        await this.memoryWorkspace.write(path, data);
        this.captured.workspace.set(path, data.slice());
      },
      read: (path, range) => this.memoryWorkspace.read(path, range),
    };
  }

  /** Create a unique data directory and compose the configured runtime with fake ports. */
  static async create(seed = randomUUID()): Promise<CanaryHarness> {
    const canaries = createCanaries(seed);
    const directory = await mkdtemp(join(tmpdir(), "harness-canary-"));
    const runtimeConfig = await loadCanaryConfig(directory);
    const reader = new RuntimeVaultReader();
    const telemetry = createCanaryTelemetry(reader);
    const clock = { now: () => 100 };
    const ids = new SequentialIdGenerator();
    const resolver = createCanarySecretResolver();
    const toolBoundary: string[] = [];
    const toolErrors: string[] = [];
    const executedTools: string[] = [];
    try {
      const runtime = await createRuntime(runtimeConfig, {
        dataDir: directory,
        roleConfigDirectory: directory,
        clock,
        ids,
        model: createCanaryModel(canaries),
        tool: createCanaryToolPort(canaries, { toolBoundary, toolErrors }, executedTools),
        secretResolver: resolver,
      });
      reader.attach(runtime);
      return new CanaryHarness({
        canaries,
        directory,
        runtimeConfig,
        runtime,
        telemetry,
        reader,
        ids,
        clock,
        toolBoundary,
        toolErrors,
        executedTools,
      });
    } catch (error) {
      telemetry.unsafeSpanCleanup();
      await Promise.all([
        telemetry.sdk.tracerProvider.shutdown(),
        telemetry.sdk.loggerProvider.shutdown(),
      ]);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Exercise goal, model, tool, exception, and approval inputs through the runtime run loop. */
  async runRuntimeScenario(): Promise<void> {
    const result = await this.runtime.run({ goal: this.canaries.email.value });
    const runId = result.events[0]?.runId;
    if (runId === undefined) {
      throw new Error("The canary runtime did not record its run.");
    }
    this.runId = runId;
    if (result.status !== "suspended") {
      throw new Error("The canary runtime did not suspend for the ask policy.");
    }
    const events: Event[] = [];
    for await (const event of this.runtime.store.read(runId)) {
      events.push(event);
    }
    const snapshot = await this.runtime.store.latestSnapshot(runId);
    this.captured.snapshot.push(JSON.stringify(snapshot ?? null));

    const response = events.find(
      (event): event is Extract<Event, { type: "model_response" }> =>
        event.type === "model_response",
    );
    const modelText = response?.content.find((part) => part.type === "text");
    if (modelText?.type !== "text") {
      throw new Error("The fake model response was not persisted.");
    }
    await this.recordCassette(modelText.text);
    const toolResult = events.find(
      (event): event is Extract<Event, { type: "tool_result" }> => event.type === "tool_result",
    );
    await this.recordOffload(JSON.stringify(toolResult?.result ?? null));

    await captureCliOutput({
      args: ["--json", "inspect", runId],
      config: this.runtimeConfig,
      runtime: this.runtime,
      clock: this.clock,
      stdout: (text) => {
        this.captured.stdout.push(text);
        this.captured.inspect.push(text);
      },
      stderr: (text) => this.captured.stderr.push(text),
    });
    await captureCliOutput({
      args: ["--json", "context", runId],
      config: this.runtimeConfig,
      runtime: this.runtime,
      clock: this.clock,
      stdout: (text) => {
        this.captured.stdout.push(text);
        this.captured.context.push(text);
      },
      stderr: (text) => this.captured.stderr.push(text),
    });
    const approval = events.find(
      (event): event is Extract<Event, { type: "approval_requested" }> =>
        event.type === "approval_requested",
    );
    if (approval === undefined) {
      throw new Error("The canary run did not create an approval request.");
    }
    await captureCliOutput({
      args: ["--json", "approvals", "show", approval.approvalId, "--show-args"],
      config: this.runtimeConfig,
      runtime: this.runtime,
      clock: this.clock,
      stdout: (text) => {
        this.captured.stdout.push(text);
        this.captured.approvals.push(text);
      },
      stderr: (text) => this.captured.stderr.push(text),
    });
  }

  /** Exercise real logging, span, and vault-resolution paths using this runtime's vault. */
  async exerciseTelemetry(): Promise<void> {
    const runId = this.requireRunId();
    await emitCanaryBadLog(this.telemetry, runId, this.canaries.email.value);
    await emitCanaryUnsafeSpan(this.telemetry, runId, this.canaries.phone.value);
    await this.telemetry.sdk.forceFlush();
  }

  /** Exercise the registered key-rotation log with synthetic row counts. */
  async exerciseKeysRotatedLog(): Promise<void> {
    await emitCanaryKeysRotated(this.telemetry);
  }

  /** Return sink names containing plaintext or encoded canary values. */
  async findLeaks(): Promise<string[]> {
    await this.telemetry.sdk.forceFlush();
    const sinks: [string, string][] = [
      ["spans", JSON.stringify(this.captured.spans)],
      ["logs", JSON.stringify(this.captured.logs)],
      ["stdout", this.captured.stdout.join("\n")],
      ["stderr", this.captured.stderr.join("\n")],
      ["cli.inspect", this.captured.inspect.join("\n")],
      ["cli.context", this.captured.context.join("\n")],
      ["cli.approvals", this.captured.approvals.join("\n")],
      ["snapshot", this.captured.snapshot.join("\n")],
      ["cassette", this.captured.cassette.join("\n")],
      ["unprotected-exporter", this.captured.unprotectedExporter.join("\n")],
      ...[...this.captured.workspace].map(([path, data]): [string, string] => [
        `workspace:${path}`,
        Buffer.from(data).toString("latin1"),
      ]),
      ...(await readDatabaseSinks([
        { name: "event-db", path: this.eventDatabasePath },
        { name: "vault-db", path: this.vaultDatabasePath },
      ])),
    ];
    return [
      ...new Set(
        this.canaries.strings.flatMap((canary) =>
          sinks.filter(([, content]) => content.includes(canary)).map(([name]) => name),
        ),
      ),
    ];
  }

  /** Confirm every seeded value resolves from the runtime's read-only audited vault. */
  async assertVaultRoundTrips(): Promise<void> {
    const entries = await this.reader.listRawValueEntries(this.requireRunId());
    const values = new Set(entries.map(({ rawValue }) => rawValue));
    for (const { value } of this.canaries.all) {
      if (!values.has(value)) {
        throw new Error("A canary did not resolve from the runtime's encrypted vault.");
      }
    }
  }

  /** Prove the release detector catches a leak when the shipped sentinel is disabled. */
  async captureWithoutSentinel(): Promise<void> {
    this.captured.unprotectedExporter.push(
      await captureWithoutSentinel(this.canaries.person.value),
    );
  }

  /** Flush and close the runtime and telemetry resources, then remove the isolated data. */
  async close(): Promise<void> {
    try {
      await this.runtime.close();
      await this.telemetry.sdk.forceFlush();
      this.telemetry.unsafeSpanCleanup();
      await Promise.all([
        this.telemetry.sdk.tracerProvider.shutdown(),
        this.telemetry.sdk.loggerProvider.shutdown(),
      ]);
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  private requireRunId(): Id {
    if (this.runId === undefined) {
      throw new Error("The canary runtime has not been run.");
    }
    return this.runId;
  }

  private async recordCassette(text: string): Promise<void> {
    const path = join(this.directory, "canary.cassette.json");
    const cassette = new FileCassetteStore(path);
    await cassette.set({
      hash: Sha256Hex.parse("b".repeat(64)),
      response: {
        parts: [{ type: "text", text }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: Code.parse("stop"),
        latencyMs: 0,
      },
    });
    this.captured.cassette.push(await readFile(path, "utf8"));
  }

  private async recordOffload(text: string): Promise<void> {
    const port: ToolPort = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: () => Promise.resolve({ outcome: "ok", result: text }),
    };
    const offloading = new OffloadingToolPort(
      port,
      this.workspace,
      {
        thresholdBytes: 1,
        previewChars: 0,
      },
      this.ids,
    );
    const call = {
      callId: Id.parse(this.ids.next()),
      toolId: ECHO_TOOL,
      args: { value: text },
    };
    const context = { runId: this.requireRunId(), signal: new AbortController().signal };
    await offloading.execute(await offloading.prepare(call, context), context);
  }
}
