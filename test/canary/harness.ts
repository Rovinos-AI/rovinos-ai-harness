// SPDX-License-Identifier: Apache-2.0
import { InMemoryWorkspace, OffloadingToolPort, type WorkspacePort } from "@harness/context";
import { FileCassetteStore } from "@harness/models";
import { buildApprovalPayload } from "@harness/policy";
import { AesGcmContentCodec, SqliteEventStore } from "@harness/store";
import {
  Code,
  Id,
  KeysConfigSchema,
  PiiConfigSchema,
  SequentialIdGenerator,
  Sha256Hex,
} from "@harness/schemas";
import { PiiEventStore, PiiToolPort, Tokenizer, type PiiToolPortLike } from "@harness/pii";
import { AuditingVaultResolver, LocalKeyProvider, SqliteVault, Token } from "@harness/vault";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCanaries, type CanarySet, type CanaryValue } from "./canaries.js";
import { recordCanaryRunContent } from "./event-content.js";
import { canaryDetections, readDatabaseSinks } from "./scanning.js";
import {
  captureWithoutCanaryGuards,
  createCanaryTelemetry,
  emitCanaryBadLog,
  emitCanaryUnsafeSpan,
  type CanaryTelemetry,
} from "./telemetry.js";

const CANARY_TOOL = Code.parse("canary.echo");

interface CapturedSinks {
  readonly spans: CanaryTelemetry["spans"];
  readonly logs: CanaryTelemetry["logs"];
  readonly stdout: string[];
  readonly stderr: string[];
  readonly inspect: string[];
  readonly context: string[];
  readonly snapshot: string[];
  readonly workspace: Map<string, Uint8Array>;
  readonly cassette: string[];
  readonly toolBoundary: string[];
  readonly approvals: string[];
  readonly unprotectedExporter: string[];
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
  readonly captured: CapturedSinks;
  readonly eventDatabasePath: string;
  readonly vaultDatabasePath: string;
  readonly workspace: WorkspacePort;

  private readonly keyProvider: LocalKeyProvider;
  private readonly vault: SqliteVault;
  private readonly store: PiiEventStore;
  private readonly tokenizer: Tokenizer;
  private readonly telemetry: CanaryTelemetry;
  private readonly ids = new SequentialIdGenerator();
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
    readonly telemetry: CanaryTelemetry;
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
    this.captured = {
      spans: input.telemetry.spans,
      logs: input.telemetry.logs,
      stdout: [],
      stderr: [],
      inspect: [],
      context: [],
      snapshot: [],
      workspace: new Map(),
      cassette: [],
      toolBoundary: [],
      approvals: [],
      unprotectedExporter: [],
    };
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
    const eventStore = new SqliteEventStore(eventDatabasePath, new AesGcmContentCodec(keyProvider));
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
    const telemetry = createCanaryTelemetry(vault);
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
    await recordCanaryRunContent({
      runId: this.runId,
      value: value.value,
      ids: this.ids,
      store: this.store,
      tokenizer: this.tokenizer,
      captureSnapshot: (snapshot) => this.captured.snapshot.push(JSON.stringify(snapshot ?? null)),
      captureInspect: (text) => this.captured.inspect.push(text),
      captureContext: (text) => this.captured.context.push(text),
      captureStderr: (text) => this.captured.stderr.push(text),
    });
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

  /** Build an approval payload from tokenized tool arguments and capture its serialized form. */
  async recordApprovalPayload(value: CanaryValue): Promise<void> {
    const tokenized = await this.tokenizer.tokenizeJson(
      this.runId,
      { value: value.value },
      { boundary: "tool_input", destination: { tool: CANARY_TOOL } },
    );
    const payload = buildApprovalPayload({
      call: {
        callId: Id.parse(this.ids.next()),
        toolId: CANARY_TOOL,
        args: tokenized.value,
      },
      rule: { id: Code.parse("canary.ask"), reason: Code.parse("test_approval") },
    });
    this.captured.approvals.push(JSON.stringify(payload));
  }

  /** Exercise PII tokenization before an actual workspace offload write. */
  async offloadToolResult(value: CanaryValue): Promise<void> {
    const inner = this.createToolPort(value, false, `${value.value} ${value.value}`);
    const offloading = new OffloadingToolPort(
      inner,
      this.workspace,
      {
        thresholdBytes: 1,
        previewChars: 0,
      },
      this.ids,
    );
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
    await emitCanaryBadLog(this.telemetry, this.runId, value.value);
  }

  /** Send an unsafe test-hook span through the processor and fail-closed sentinel. */
  async emitUnsafeSpan(value: CanaryValue): Promise<void> {
    await emitCanaryUnsafeSpan(this.telemetry, this.runId, value.value);
  }

  /** Export a raw span without either the allowlist processor or sentinel gate. */
  async captureWithoutSentinelOrProcessor(value: CanaryValue): Promise<void> {
    this.captured.unprotectedExporter.push(await captureWithoutCanaryGuards(value.value));
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
      ["snapshot", this.captured.snapshot.join("\n")],
      ["cassette", this.captured.cassette.join("\n")],
      ["approval", this.captured.approvals.join("\n")],
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
    this.telemetry.unsafeSpanCleanup();
    await this.telemetry.sdk.tracerProvider.shutdown();
    await this.telemetry.sdk.loggerProvider.shutdown();
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
    await this.telemetry.sdk.forceFlush();
  }
}
