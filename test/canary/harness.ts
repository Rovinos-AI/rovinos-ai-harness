// SPDX-License-Identifier: Apache-2.0
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { InMemoryWorkspace, OffloadingToolPort, type WorkspacePort } from "@harness/context";
import { FileCassetteStore } from "@harness/models";
import { AesGcmContentCodec, SqliteEventStore } from "@harness/store";
import {
  Code,
  Id,
  KeysConfigSchema,
  PiiConfigSchema,
  SequentialIdGenerator,
  Sha256Hex,
  type Event,
  type Detection,
  type NewEvent,
} from "@harness/schemas";
import { PiiEventStore, PiiToolPort, Tokenizer, type PiiToolPortLike } from "@harness/pii";
import {
  attr,
  createTelemetrySdk,
  defineLogRecord,
  SentinelGate,
  VaultRunView,
  type TelemetrySdkOptions,
} from "@harness/telemetry";
import { __registerUnsafeSpanForTests } from "@harness/telemetry/testing";
import { AuditingVaultResolver, LocalKeyProvider, SqliteVault, Token } from "@harness/vault";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createCanaries, type CanarySet, type CanaryValue } from "./canaries.js";

const CANARY_TOOL = Code.parse("canary.echo");
const TRACE_ID = "a".repeat(32);
const SPAN_ID = "b".repeat(16);
const UNSAFE_SPAN_NAME = "harness.canary.unsafe";

const canaryLog = defineLogRecord("harness.canary.pipeline", {
  "harness.run.id": attr.id(),
  "harness.error.code": attr.code(),
});

type ExportedSpan = Parameters<TelemetrySdkOptions["spanExporter"]["export"]>[0][number];
type ExportedLog = Parameters<TelemetrySdkOptions["logExporter"]["export"]>[0][number];

interface CapturedSinks {
  readonly spans: ExportedSpan[];
  readonly logs: ExportedLog[];
  readonly stdout: string[];
  readonly stderr: string[];
  readonly inspect: string[];
  readonly context: string[];
  readonly workspace: Map<string, Uint8Array>;
  readonly cassette: string[];
  readonly toolBoundary: string[];
}

function testKeyProvider(): LocalKeyProvider {
  const key = Buffer.alloc(32, 37).toString("base64");
  return new LocalKeyProvider({
    config: KeysConfigSchema.parse({
      currentKeyId: "canary-test-key",
      keys: [{ id: "canary-test-key", secret: "env:CANARY_TEST_KEY" }],
    }),
    secretResolver: { resolve: () => Promise.resolve({ reveal: () => key }) },
    env: { NODE_ENV: "test" },
    onWarning: () => undefined,
  });
}

/**
 * Composes the production storage, tokenizer, tool, telemetry, and offload boundaries with
 * isolated SQLite files and capture sinks for the release-gate scenario matrix.
 */
export class CanaryHarness {
  readonly canaries: CanarySet;
  readonly runId: Id;
  readonly captured: CapturedSinks = {
    spans: [],
    logs: [],
    stdout: [],
    stderr: [],
    inspect: [],
    context: [],
    workspace: new Map(),
    cassette: [],
    toolBoundary: [],
  };
  readonly eventDatabasePath: string;
  readonly vaultDatabasePath: string;
  readonly workspace: WorkspacePort;

  private readonly keyProvider: LocalKeyProvider;
  private readonly vault: SqliteVault;
  private readonly store: PiiEventStore;
  private readonly tokenizer: Tokenizer;
  private readonly telemetry: ReturnType<typeof createTelemetrySdk>;
  private readonly ids = new SequentialIdGenerator();
  private readonly unsafeSpanCleanup: () => void;
  private readonly directory: string;
  private readonly memoryWorkspace = new InMemoryWorkspace();

  private constructor(input: {
    readonly canaries: CanarySet;
    readonly directory: string;
    readonly eventDatabasePath: string;
    readonly vaultDatabasePath: string;
    readonly keyProvider: LocalKeyProvider;
    readonly vault: SqliteVault;
    readonly store: PiiEventStore;
    readonly tokenizer: Tokenizer;
    readonly telemetry: ReturnType<typeof createTelemetrySdk>;
    readonly unsafeSpanCleanup: () => void;
  }) {
    this.canaries = input.canaries;
    this.directory = input.directory;
    this.eventDatabasePath = input.eventDatabasePath;
    this.vaultDatabasePath = input.vaultDatabasePath;
    this.keyProvider = input.keyProvider;
    this.vault = input.vault;
    this.store = input.store;
    this.tokenizer = input.tokenizer;
    this.telemetry = input.telemetry;
    this.unsafeSpanCleanup = input.unsafeSpanCleanup;
    this.runId = Id.parse(this.ids.next());
    this.workspace = {
      write: async (path, data) => {
        await this.memoryWorkspace.write(path, data);
        this.captured.workspace.set(path, data.slice());
      },
      read: (path, range) => this.memoryWorkspace.read(path, range),
    };
  }

  /** Create isolated encrypted databases, seed exact canaries, and install capture exporters. */
  static async create(seed = randomUUID()): Promise<CanaryHarness> {
    const canaries = createCanaries(seed);
    const directory = await mkdtemp(join(tmpdir(), "harness-canary-"));
    const eventDatabasePath = join(directory, "events.sqlite");
    const vaultDatabasePath = join(directory, "vault.sqlite");
    const keyProvider = testKeyProvider();
    const vault = new SqliteVault(vaultDatabasePath, keyProvider);
    const eventStore = new SqliteEventStore(
      eventDatabasePath,
      new AesGcmContentCodec(keyProvider),
    );
    const config = PiiConfigSchema.parse({
      detokenize: [{ toolId: CANARY_TOOL, args: ["/value"] }],
    });
    const tokenizer = new Tokenizer({
      policy: config,
      vault,
      detectors: {
        detect: (text) => canaryDetections(canaries, text),
      },
    });
    const store = new PiiEventStore(eventStore, tokenizer);
    const spans: ExportedSpan[] = [];
    const logRecords: ExportedLog[] = [];
    const telemetry = createTelemetrySdk({
      spanExporter: {
        export: (finished, callback) => {
          spans.push(...finished);
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      },
      logExporter: {
        export: (finished, callback) => {
          logRecords.push(...finished);
          callback({ code: ExportResultCode.SUCCESS });
        },
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
      gate: new SentinelGate(new VaultRunView(vault), undefined, { maxPrepareMs: 1_000 }),
      telemetry: { sentinel: { minValueLength: 6, enabled: true } },
    });
    if (!trace.setGlobalTracerProvider(telemetry.tracerProvider)) {
      throw new Error("The canary tracer provider could not be registered.");
    }
    logs.setGlobalLoggerProvider(telemetry.loggerProvider);
    if (logs.getLoggerProvider() !== telemetry.loggerProvider) {
      throw new Error("The canary logger provider could not be registered.");
    }

    const unsafeSpanCleanup = __registerUnsafeSpanForTests(UNSAFE_SPAN_NAME, {
      "harness.run.id": Id,
      "harness.canary.value": z.string(),
    });
    const harness = new CanaryHarness({
      canaries,
      directory,
      eventDatabasePath,
      vaultDatabasePath,
      keyProvider,
      vault,
      store,
      tokenizer,
      telemetry,
      unsafeSpanCleanup,
    });
    for (const value of canaries.all) {
      await vault.put(harness.runId, value.entityType, value.value);
    }
    return harness;
  }

  /** Tokenize a raw value at a selected boundary and capture the resulting sink payload. */
  async captureTokenized(
    sink: "stdout" | "stderr" | "inspect" | "context",
    value: CanaryValue,
    boundary: "model_input" | "tool_output" | "storage" | "ui" = "storage",
  ): Promise<string> {
    const result = await this.tokenizer.tokenizeText(this.runId, value.value, {
      boundary,
      destination: "local",
    });
    this.captured[sink].push(result.text);
    return result.text;
  }

  /** Write goal, model response, and snapshot content through the PII-aware event store. */
  async recordRunContent(value: CanaryValue): Promise<void> {
    const runEnvelope = {
      runId: this.runId,
      ts: 100,
      v: 1 as const,
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      segmentId: this.runId,
    };
    const initial: NewEvent[] = [
      {
        ...runEnvelope,
        type: "run_created",
        configHash: "a".repeat(64),
        policyVersion: "canary.v1",
        depth: 0,
      },
      {
        ...runEnvelope,
        type: "run_input",
        input: { goal: value.value },
        inputKind: "initial",
      },
      {
        ...runEnvelope,
        type: "model_response",
        requestId: Id.parse(this.ids.next()),
        provider: "synthetic",
        model: "synthetic",
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        content: [{ type: "text", text: value.value }],
        providerBlobs: null,
      },
    ];
    await this.store.append(this.runId, initial, 0);

    const snapshotId = Id.parse(this.ids.next());
    const checkpoint: NewEvent = {
      ...runEnvelope,
      type: "checkpoint_written",
      checkpointId: snapshotId,
      atSeq: 3,
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
    };
    const snapshot = {
      snapshotId,
      runId: this.runId,
      atSeq: 3,
      createdAt: 100,
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
      context: { content: value.value },
      plan: { content: value.value },
    };
    await this.store.appendWithSnapshot(this.runId, [checkpoint], 3, snapshot);

    const persisted: Event[] = [];
    for await (const event of this.store.read(this.runId)) {
      persisted.push(event);
    }
    this.captured.inspect.push(JSON.stringify(persisted.map(({ type, seq }) => ({ type, seq }))));
    this.captured.context.push(JSON.stringify(await this.store.latestSnapshot(this.runId)));
  }

  /** Exercise the real tool-input/output decorator, retaining raw args only in tool memory. */
  async runTool(value: CanaryValue, options: { readonly failure?: boolean } = {}): Promise<string> {
    const port = this.createToolPort(value, options.failure === true);
    const call = {
      callId: Id.parse(this.ids.next()),
      toolId: CANARY_TOOL,
      args: { value: value.value },
    };
    const context = { runId: this.runId, signal: new AbortController().signal };
    const prepared = await port.prepare(call, context);
    const result = await port.execute(prepared, context);
    return JSON.stringify(result);
  }

  /** Exercise PII tokenization before an actual workspace offload write. */
  async offloadToolResult(value: CanaryValue): Promise<void> {
    const inner = this.createToolPort(value, false, `${value.value} ${value.value}`);
    const offloading = new OffloadingToolPort(inner, this.workspace, {
      thresholdBytes: 1,
      previewChars: 0,
    }, this.ids);
    const call = {
      callId: Id.parse(this.ids.next()),
      toolId: CANARY_TOOL,
      args: { value: value.value },
    };
    const context = { runId: this.runId, signal: new AbortController().signal };
    const prepared = await offloading.prepare(call, context);
    await offloading.execute(prepared, context);
  }

  /** Send a malformed log field through the real allowlist and sentinel pipeline. */
  async emitBadLog(value: CanaryValue): Promise<void> {
    logs.getLogger("@harness/telemetry").emit({
      eventName: canaryLog.name,
      severityNumber: SeverityNumber.INFO,
      attributes: {
        "harness.run.id": this.runId,
        "harness.error.code": value.value,
      },
    });
    await this.flushTelemetry();
  }

  /** Send an unsafe test-hook span through the processor and fail-closed sentinel. */
  async emitUnsafeSpan(value: CanaryValue): Promise<void> {
    const span = this.telemetry.tracerProvider.getTracer("@harness/canary").startSpan(
      UNSAFE_SPAN_NAME,
      {
        attributes: {
          "harness.run.id": this.runId,
          "harness.canary.value": value.value,
        },
      },
    );
    span.end();
    await this.flushTelemetry();
  }

  /** Persist tokenized model content using the real file-backed cassette store. */
  async recordCassette(value: CanaryValue): Promise<void> {
    const { text } = await this.tokenizer.tokenizeText(this.runId, value.value, {
      boundary: "storage",
      destination: "local",
    });
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

  /** Capture an unguarded payload to prove the leak assertions fail closed. */
  captureUnprotectedSink(sink: "stdout" | "stderr", value: string): void {
    this.captured[sink].push(value);
  }

  /** Return sink names that contain any plaintext or encoded canary value. */
  async findLeaks(): Promise<string[]> {
    await this.flushTelemetry();
    const sinks: [string, string][] = [
      ["spans", JSON.stringify(this.captured.spans)],
      ["logs", JSON.stringify(this.captured.logs)],
      ["stdout", this.captured.stdout.join("\n")],
      ["stderr", this.captured.stderr.join("\n")],
      ["cli.inspect", this.captured.inspect.join("\n")],
      ["cli.context", this.captured.context.join("\n")],
      ["cassette", this.captured.cassette.join("\n")],
      ...[...this.captured.workspace].map(([path, data]) => [
        `workspace:${path}`,
        Buffer.from(data).toString("latin1"),
      ] as [string, string]),
      ...await this.databaseSinks(),
    ];
    return [
      ...new Set(
        this.canaries.strings.flatMap((canary) =>
          sinks.filter(([, content]) => content.includes(canary)).map(([name]) => name),
        ),
      ),
    ];
  }

  /** Check the encrypted vault contains every value while its file bytes contain none. */
  async assertVaultRoundTrips(): Promise<void> {
    for (const value of this.canaries.all) {
      const token = Token.parse(await this.vault.put(this.runId, value.entityType, value.value));
      const resolved = await this.vault.resolve(this.runId, token, {
        boundary: "tool_input",
        toolId: CANARY_TOOL,
      });
      if (resolved !== value.value) {
        throw new Error("A canary did not resolve from the encrypted vault.");
      }
    }
  }

  /** Shut down exporters and remove the isolated databases and temporary files. */
  async close(): Promise<void> {
    await this.flushTelemetry();
    this.unsafeSpanCleanup();
    await this.telemetry.tracerProvider.shutdown();
    await this.telemetry.loggerProvider.shutdown();
    await this.store.close();
    this.vault.close();
    this.keyProvider.dispose();
    await rm(this.directory, { recursive: true, force: true });
  }

  private createToolPort(
    value: CanaryValue,
    failure: boolean,
    result: string = value.value,
  ): PiiToolPort {
    const inner: PiiToolPortLike = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: (call) => {
        this.captured.toolBoundary.push(JSON.stringify(call.args));
        if (failure) {
          return Promise.reject(new Error(`${value.value}\n${new Error(value.value).stack ?? ""}`));
        }
        return Promise.resolve({ outcome: "ok", result: { value: result } });
      },
    };
    return new PiiToolPort(inner, {
      tokenizer: this.tokenizer,
      config: PiiConfigSchema.parse({
        detokenize: [{ toolId: CANARY_TOOL, args: ["/value"] }],
      }),
      resolver: new AuditingVaultResolver(this.vault, () => undefined),
    });
  }

  private async flushTelemetry(): Promise<void> {
    await this.telemetry.forceFlush();
  }

  private async databaseSinks(): Promise<[string, string][]> {
    const result: [string, string][] = [];
    for (const [name, path] of [
      ["event-db", this.eventDatabasePath],
      ["vault-db", this.vaultDatabasePath],
    ] as const) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          const bytes = await readFile(`${path}${suffix}`);
          result.push([`${name}${suffix}`, bytes.toString("latin1")]);
        } catch {
          // SQLite sidecar files are created only while a connection needs them.
        }
      }
    }
    return result;
  }
}

function canaryDetections(canaries: CanarySet, text: string) {
  return canaries.all.flatMap(({ value, entityType }) => {
    const detections: Detection[] = [];
    let start = text.indexOf(value);
    while (start >= 0) {
      detections.push({
        entityType,
        start,
        end: start + value.length,
        confidence: 1,
        detectorId: "canary.synthetic",
      });
      start = text.indexOf(value, start + value.length);
    }
    return detections;
  });
}

export async function scanCommittedFixtures(repositoryRoot: string): Promise<string[]> {
  const matches: string[] = [];
  const queue = [repositoryRoot];
  const detector =
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?1[- .]?)?(?:\(?\d{3}\)?[- .]?)\d{3}[- .]\d{4}|\b\d{13,19}\b|hsk_live_[a-f0-9]{24}|(?:Ada|Grace|Katherine|Margaret)-[a-f0-9]{8}/iu;

  while (queue.length > 0) {
    const directory = queue.pop();
    if (directory === undefined) {
      continue;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (![".git", ".yarn", "dist", "node_modules"].includes(entry.name)) {
          queue.push(join(directory, entry.name));
        }
        continue;
      }
      const path = join(directory, entry.name);
      const fixture = path.split("/").includes("__fixtures__");
      const cassette = path.includes(`${join(repositoryRoot, "test")}${"/"}`) &&
        path.endsWith(".cassette.json");
      if (!fixture && !cassette) {
        continue;
      }
      if (detector.test(await readFile(path, "utf8"))) {
        matches.push(path);
      }
    }
  }
  return matches;
}
