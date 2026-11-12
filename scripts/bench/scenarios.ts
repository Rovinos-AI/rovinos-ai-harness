// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { Bench } from "tinybench";
import { HarnessConfigSchema } from "@rovinos/config";
import { foldRunState, RUN_SPAN } from "@rovinos/core";
import { Tokenizer } from "@rovinos/pii";
import { InMemoryEventStore, type EventStore } from "@rovinos/store";
import { SqliteEventStore, SqliteRunQueue } from "@rovinos/store-sqlite";
import { PostgresEventStore } from "@rovinos/store-postgres";
import {
  Code,
  Id,
  Principal,
  PiiPolicySchema,
  type Event,
  type NewEvent,
} from "@rovinos/schemas";
import {
  createHarness,
  McpCatalogInspectionSchema,
  registerMcpServer,
  selectMcpTools,
} from "@rovinos/sdk";
import {
  SentinelGate,
  sanitizeSpan,
  TripQueue,
  VaultRunView,
} from "@rovinos/telemetry";
import { createTestSpanCollector, StaticVaultReader } from "@rovinos/telemetry/testing";
import { InMemoryVault } from "@rovinos/vault";
import { BenchmarkResultSchema, type BenchmarkResult } from "./contracts.js";

const hash = "a".repeat(64);
const traceId = "b".repeat(32);
const spanId = "c".repeat(16);
const ID_LIMIT = 26;
const MAX_LOG_EVENTS = 100_000;

export interface BenchmarkProfile {
  readonly name: "smoke" | "nightly";
  readonly durationMs: number;
  readonly warmupMs: number;
}

export const BENCHMARK_PROFILES: Readonly<Record<"smoke" | "nightly", BenchmarkProfile>> = {
  smoke: { name: "smoke", durationMs: 10, warmupMs: 0 },
  nightly: { name: "nightly", durationMs: 1000, warmupMs: 200 },
};

interface Measurement {
  readonly p95Ms: number;
  readonly operationsPerSecond: number;
  readonly sampleCount: number;
}

function makeId(value: number): Id {
  return Id.parse(String(value).padStart(ID_LIMIT, "0"));
}

function runCreated(runId: Id, ts: number): NewEvent {
  return {
    runId,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
    type: "run_created",
    configHash: hash,
    policyVersion: "bench",
    depth: 0,
  };
}

function runInput(runId: Id, ts: number): NewEvent {
  return {
    runId,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
    type: "run_input",
    input: { value: "synthetic benchmark input" },
    inputKind: "follow_up",
  };
}

function statusChange(
  runId: Id,
  ts: number,
  from: "pending" | "running",
  to: "running" | "completed" | "suspended",
  reason: "started" | "completed" | "awaiting_approval",
): NewEvent {
  return {
    runId,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
    type: "run_status_changed",
    from,
    to,
    reason,
  };
}

function approvalRequested(runId: Id, approvalId: Id, ts: number): NewEvent {
  return {
    runId,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
    type: "approval_requested",
    approvalId,
    callId: makeId(900_000 + Number(approvalId.slice(-6))),
    payload: {},
  };
}

async function measure(
  name: string,
  callback: () => Promise<unknown> | unknown,
  profile: BenchmarkProfile,
): Promise<Measurement> {
  const bench = new Bench({
    name,
    time: profile.durationMs,
    warmupTime: profile.warmupMs,
    retainSamples: true,
  });
  bench.add(name, callback);
  await bench.run();
  const task = bench.getTask(name);
  if (task === undefined || !("latency" in task.result) || !("throughput" in task.result)) {
    throw new Error("benchmark_failed");
  }
  const samples = task.result.latency.samples;
  if (samples === undefined || samples.length === 0) {
    throw new Error("benchmark_samples_missing");
  }
  const sortedSamples = [...samples].sort((left, right) => left - right);
  const p95Index = Math.min(sortedSamples.length - 1, Math.ceil(sortedSamples.length * 0.95) - 1);
  const p95Sample = sortedSamples[p95Index];
  if (p95Sample === undefined || !Number.isFinite(p95Sample)) {
    throw new Error("benchmark_samples_invalid");
  }
  return {
    p95Ms: p95Sample,
    operationsPerSecond: task.result.throughput.mean,
    sampleCount: task.runs,
  };
}

function metric(
  name: string,
  value: number,
  unit: "ops/s" | "events/s" | "ms" | "MiB/s",
  sampleCount: number,
): BenchmarkResult["metrics"][number] {
  return { name, value: Math.max(0, value), unit, sampleCount: Math.max(1, sampleCount) };
}

async function appendBenchmarks(
  profile: BenchmarkProfile,
  store: EventStore,
  label: "sqlite" | "postgres",
): Promise<BenchmarkResult["metrics"]> {
  const metrics: BenchmarkResult["metrics"] = [];
  for (const batchSize of [1, 10, 100]) {
    const runId = makeId(label === "sqlite" ? 100 + batchSize : 200 + batchSize);
    await store.append(runId, [runCreated(runId, 1)], 0);
    let expectedSeq = 1;
    let ts = 2;
    const result = await measure(
      `${label}.append.${String(batchSize)}`,
      async () => {
        const events = Array.from({ length: batchSize }, () => runInput(runId, ts++));
        await store.append(runId, events, expectedSeq);
        expectedSeq += batchSize;
      },
      profile,
    );
    metrics.push(
      metric(
        `store.${label}.append.batch_${String(batchSize)}`,
        result.operationsPerSecond * batchSize,
        "events/s",
        result.sampleCount,
      ),
    );
  }
  return metrics;
}

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function appendInputBatch(store: EventStore, runId: Id, from: number, count: number) {
  const events = Array.from({ length: count }, (_, index) => runInput(runId, from + index));
  await store.append(runId, events, from - 1);
}

async function seedLongLog(
  store: EventStore,
  runId: Id,
  count: number,
  withSnapshot: boolean,
): Promise<number> {
  await store.append(
    runId,
    [runCreated(runId, 1), statusChange(runId, 2, "pending", "running", "started")],
    0,
  );
  let expectedSeq = 2;
  const firstPart = withSnapshot ? Math.floor(count * 0.9) : count;
  for (let offset = 0; offset < firstPart; offset += 10_000) {
    const batchSize = Math.min(10_000, firstPart - offset);
    const events = Array.from({ length: batchSize }, (_, index) =>
      runInput(runId, offset + index + 3),
    );
    await store.append(runId, events, expectedSeq);
    expectedSeq += batchSize;
  }
  if (withSnapshot) {
    const snapshotId = makeId(Number(runId.slice(-6)) + 1_000_000);
    const traceparent = `00-${traceId}-${spanId}-01`;
    await store.appendWithSnapshot(
      runId,
      [
        {
          runId,
          ts: expectedSeq + 1,
          v: 1,
          traceId,
          spanId,
          segmentId: runId,
          type: "checkpoint_written",
          checkpointId: snapshotId,
          atSeq: expectedSeq,
          traceparent,
        },
      ],
      expectedSeq,
      {
        snapshotId,
        runId,
        v: 1,
        atSeq: expectedSeq,
        createdAt: expectedSeq + 1,
        traceparent,
        context: {},
        plan: null,
      },
    );
    expectedSeq += 1;
    for (let offset = firstPart; offset < count; offset += 10_000) {
      const batchSize = Math.min(10_000, count - offset);
      const events = Array.from({ length: batchSize }, (_, index) =>
        runInput(runId, offset + index + 3),
      );
      await store.append(runId, events, expectedSeq);
      expectedSeq += batchSize;
    }
  }
  return withSnapshot ? count + 3 : count + 2;
}

async function storeReadAndResumeBenchmarks(profile: BenchmarkProfile) {
  const count = profile.name === "nightly" ? MAX_LOG_EVENTS : 25;
  const store = new InMemoryEventStore();
  const runId = makeId(300);
  const nextSeq = await seedLongLog(store, runId, count, true);
  const latest = await store.latestSnapshot(runId);
  if (latest === undefined) {
    throw new Error("snapshot_missing");
  }
  const readFold = await measure(
    "store.read_fold",
    async () => foldRunState(await readEvents(store, runId)),
    profile,
  );
  const fullResume = await measure(
    "store.resume.full",
    async () => foldRunState(await readEvents(store, runId)),
    profile,
  );
  const snapshotTail = await measure(
    "store.resume.snapshot",
    async () => {
      let countRead = 0;
      for await (const _event of store.read(runId, { fromSeq: latest.atSeq + 1 })) {
        countRead += 1;
      }
      return countRead;
    },
    profile,
  );
  const events = await readEvents(store, runId);
  if (events.length !== nextSeq) {
    throw new Error("event_count_mismatch");
  }
  await store.close();
  return [
    metric("store.read_fold.100k", readFold.p95Ms, "ms", readFold.sampleCount),
    metric("store.resume.full_log", fullResume.p95Ms, "ms", fullResume.sampleCount),
    metric("store.resume.snapshot_tail", snapshotTail.p95Ms, "ms", snapshotTail.sampleCount),
  ];
}

function syntheticVaultValues(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    entityType: Code.parse("email"),
    rawValue: `a${index.toString(36).padStart(4, "0")}z`,
  }));
}

async function sentinelBenchmarks(profile: BenchmarkProfile) {
  const runId = makeId(400);
  const metrics: BenchmarkResult["metrics"] = [];
  for (const [label, count] of [
    ["1000", profile.name === "nightly" ? 1_000 : 10],
    ["10000", profile.name === "nightly" ? 10_000 : 20],
    ["100000", profile.name === "nightly" ? 100_000 : 30],
  ] as const) {
    const reader = new StaticVaultReader(new Map([[runId, syntheticVaultValues(count)]]));
    const gate = new SentinelGate(
      new VaultRunView(reader),
      undefined,
      {
        maxPrepareMs: 120_000,
        maxScanMs: 120_000,
        tripQueue: new TripQueue({ emit: () => undefined, enabled: () => true }),
      },
    );
    await gate.check({ runId, text: "warmup synthetic span payload" });
    const result = await measure(
      `sentinel.${label}`,
      () => gate.check({ runId, text: "synthetic safe span payload" }),
      profile,
    );
    metrics.push(metric(`sentinel.p95.${label}`, result.p95Ms, "ms", result.sampleCount));
  }
  return metrics;
}

async function tokenizerBenchmark(profile: BenchmarkProfile) {
  const vault = new InMemoryVault();
  const tokenizer = new Tokenizer({
    vault,
    policy: PiiPolicySchema.parse({}),
    detectors: {
      detect: (text) => {
        const match = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u.exec(text);
        const start = match?.index;
        return match === null || start === undefined
          ? []
          : [
              {
                entityType: "email",
                start,
                end: start + match[0].length,
                confidence: 1,
                detectorId: "bench.email",
              },
            ];
      },
    },
  });
  const mixed = "synthetic text with demo@example.test and mixed Unicode café. ";
  const safe = "synthetic path with mixed Unicode café and safe content. ";
  const text = `${mixed}${safe.repeat(Math.ceil(1_048_576 / safe.length))}`.slice(0, 1_048_576);
  const runId = makeId(500);
  const result = await measure(
    "pii.tokenizer",
    () =>
      tokenizer.tokenizeText(runId, text, {
        boundary: "tool_output",
        destination: "any",
      }),
    profile,
  );
  return metric(
    "pii.tokenizer.1mib",
    (Buffer.byteLength(text) / 1_048_576) * result.operationsPerSecond,
    "MiB/s",
    result.sampleCount,
  );
}

async function allowlistSentinelBenchmark(profile: BenchmarkProfile) {
  void RUN_SPAN;
  const runId = makeId(600);
  const reader = new StaticVaultReader(new Map([[runId, syntheticVaultValues(100)]]));
  const gate = new SentinelGate(
    new VaultRunView(reader),
    undefined,
    { tripQueue: new TripQueue({ emit: () => undefined, enabled: () => true }) },
  );
  const collector = createTestSpanCollector();
  const span = collector.provider
    .getTracer("bench")
    .startSpan("harness.run", {
      attributes: { "harness.run.id": runId, "harness.segment.id": runId },
    });
  span.end();
  const readableSpan = collector.getFinishedSpans()[0];
  if (readableSpan === undefined) {
    throw new Error("span_missing");
  }
  const result = await measure(
    "telemetry.allowlist_sentinel",
    async () => {
      const sanitized = sanitizeSpan(readableSpan);
      if (sanitized === undefined) {
        throw new Error("span_rejected");
      }
      const text = JSON.stringify([sanitized.name, sanitized.attributes, sanitized.resource.attributes]);
      return gate.check({ runId, text });
    },
    profile,
  );
  await collector.provider.shutdown();
  return metric(
    "telemetry.allowlist_sentinel.spans",
    result.operationsPerSecond,
    "ops/s",
    result.sampleCount,
  );
}

async function queueBenchmark(profile: BenchmarkProfile) {
  const queue = new SqliteRunQueue(":memory:");
  const batchSize = profile.name === "nightly" ? 25 : 2;
  for (let index = 0; index < batchSize * 4; index += 1) {
    await queue.enqueue({ kind: "start", runId: makeId(10_000 + index) });
  }
  const result = await measure(
    "queue.claim.4_workers",
    async () => {
      const workers = Array.from({ length: 4 }, (_, index) => `bench.worker_${String(index)}`);
      const claims = await Promise.all(
        workers.map(async (worker) => ({
          worker,
          jobs: await queue.claim(worker, batchSize, 60_000),
        })),
      );
      await Promise.all(
        claims.flatMap(({ worker, jobs }) => jobs.map((job) => queue.release(job.jobId, worker))),
      );
    },
    profile,
  );
  await queue.close();
  return metric(
    "queue.claim.4_workers",
    result.operationsPerSecond,
    "ops/s",
    result.sampleCount,
  );
}

async function createHarnessForBench(store: InMemoryEventStore) {
  return createHarness({
    config: HarnessConfigSchema.parse({}),
    contentAuthorizer: () => true,
    overrides: { store, transientVault: true },
  });
}

async function seedApprovalRuns(store: EventStore, count: number) {
  const runCount = count;
  for (let index = 0; index < runCount; index += 1) {
    const runId = makeId(20_000 + index);
    const approvalId = makeId(30_000 + index);
    await store.append(
      runId,
      [
        runCreated(runId, index * 4 + 1),
        statusChange(runId, index * 4 + 2, "pending", "running", "started"),
        approvalRequested(runId, approvalId, index * 4 + 3),
        statusChange(runId, index * 4 + 4, "running", "suspended", "awaiting_approval"),
      ],
      0,
    );
  }
}

async function sdkBenchmarks(profile: BenchmarkProfile) {
  const count = profile.name === "nightly" ? MAX_LOG_EVENTS : 25;
  const store = new InMemoryEventStore();
  const runId = makeId(700);
  await store.append(
    runId,
    [runCreated(runId, 1), statusChange(runId, 2, "pending", "running", "started")],
    0,
  );
  await appendInputBatch(store, runId, 3, count);
  await store.append(
    runId,
    [statusChange(runId, count + 3, "running", "completed", "completed")],
    count + 2,
  );
  const harness = await createHarnessForBench(store);
  const fullHistory = await measure("sdk.full_history", () => harness.getRun(runId), profile);
  const stream = await measure(
    "sdk.content_stream",
    async () => {
      let entries = 0;
      for await (const _entry of harness.streamRunContent(runId, {
        principal: Principal.parse("cli.bench"),
      })) {
        entries += 1;
        await Promise.resolve();
      }
      return entries;
    },
    profile,
  );
  await seedApprovalRuns(store, profile.name === "nightly" ? 1_000 : 10);
  const approvalLookup = await measure(
    "sdk.pending_approval",
    async () => {
      try {
        await harness.resolveApproval(makeId(99_999_999), "approve", {
          principal: Principal.parse("cli.bench"),
        });
      } catch {
        return false;
      }
      return true;
    },
    profile,
  );
  const result = [
    metric("sdk.full_history.100k", fullHistory.p95Ms, "ms", fullHistory.sampleCount),
    metric("sdk.pending_approval.1000_runs", approvalLookup.p95Ms, "ms", approvalLookup.sampleCount),
    metric("sdk.content_stream.backpressure", stream.p95Ms, "ms", stream.sampleCount),
  ];
  await harness.close();
  return result;
}

function mcpCatalog(size: number) {
  const serverId = "bench_server";
  const tools = Array.from({ length: size }, (_, index) => ({
    name: `tool_${String(index)}`,
    toolId: `bench.tool_${String(index)}`,
    description: "Synthetic benchmark tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    exposed: false,
  }));
  const inspection = McpCatalogInspectionSchema.parse({
    serverId,
    catalogVersion: hash,
    tools,
    rejectedTools: [],
  });
  const config = registerMcpServer(
    {},
    {
      id: serverId,
      transport: { kind: "stdio", command: "node", args: ["synthetic-server.js"] },
    },
  );
  return { inspection, config };
}

async function mcpBenchmarks(profile: BenchmarkProfile) {
  const size = profile.name === "nightly" ? 1_000 : 10;
  const { config, inspection } = mcpCatalog(size);
  const selection = await measure(
    "sdk.mcp_catalog",
    () =>
      selectMcpTools(
        config,
        inspection,
        inspection.tools.slice(0, Math.min(32, size)).map(({ name }) => name),
      ),
    profile,
  );
  const rejected = {
    serverId: "bench_server",
    catalogVersion: hash,
    tools: Array.from({ length: size }, () => ({
      name: "",
      toolId: "",
      description: "",
      inputSchema: [],
      exposed: false,
    })),
    rejectedTools: [],
  };
  const rejectionStorm = await measure(
    "sdk.mcp_rejection_storm",
    () => McpCatalogInspectionSchema.safeParse(rejected),
    profile,
  );
  const transferBytes = profile.name === "nightly" ? 1_048_576 : 1024;
  const payload = Buffer.alloc(transferBytes, 7);
  const encoded = payload.toString("base64");
  const mixedResult = {
    format: "mcp-tool-result",
    version: 1,
    isError: false,
    parts: [
      { type: "text", text: "synthetic result" },
      {
        type: "resource_link",
        uri: "file://synthetic",
        name: "synthetic artifact",
        artifact: {
          handle: "wf_00000000000000000000000000",
          mimeType: "application/octet-stream",
          bytes: transferBytes,
          sha256: hash,
        },
      },
    ],
  };
  const offload = await measure(
    "mcp.mixed_result_offload",
    () => {
      const decoded = Buffer.from(encoded, "base64");
      const checksum = createHash("sha256").update(decoded).digest("hex");
      const normalized = JSON.stringify(mixedResult);
      return `${checksum}${normalized}`;
    },
    profile,
  );
  return [
    metric("sdk.mcp_catalog.1000_tools", selection.p95Ms, "ms", selection.sampleCount),
    metric("sdk.mcp.rejection_storm.1000", rejectionStorm.p95Ms, "ms", rejectionStorm.sampleCount),
    metric(
      "mcp.mixed_result_offload",
      (transferBytes / 1_048_576) * offload.operationsPerSecond,
      "MiB/s",
      offload.sampleCount,
    ),
  ];
}

export async function runBenchmarks(profile: BenchmarkProfile): Promise<BenchmarkResult> {
  const sqliteStore = new SqliteEventStore(":memory:");
  const metrics = [
    ...(await appendBenchmarks(profile, sqliteStore, "sqlite")),
    ...(await storeReadAndResumeBenchmarks(profile)),
    ...(await sentinelBenchmarks(profile)),
    await tokenizerBenchmark(profile),
    await allowlistSentinelBenchmark(profile),
    await queueBenchmark(profile),
    ...(await sdkBenchmarks(profile)),
    ...(await mcpBenchmarks(profile)),
  ];
  await sqliteStore.close();

  const databaseUrl = process.env.DATABASE_URL;
  if (profile.name === "nightly" && databaseUrl === undefined) {
    throw new Error("postgres_url_required");
  }
  if (databaseUrl !== undefined) {
    const postgresStore = new PostgresEventStore(databaseUrl);
    try {
      metrics.push(...(await appendBenchmarks(profile, postgresStore, "postgres")));
    } finally {
      await postgresStore.close();
    }
  }

  const cpu = cpus()[0];
  const cpuCount = cpus().length;
  return BenchmarkResultSchema.parse({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    environment: {
      runner:
        process.env.GITHUB_ACTIONS === "true"
          ? "ubuntu-24.04"
          : process.env.BENCH_RUNNER ?? "local",
      platform: process.platform,
      architecture: process.arch,
      cpu: cpu?.model ?? "unknown",
      cpuCount: Math.max(1, cpuCount),
      memoryBytes: totalmem(),
      node: process.version,
    },
    sample: {
      profile: profile.name,
      durationMs: profile.durationMs,
      warmupMs: profile.warmupMs,
    },
    metrics,
  });
}

export const benchmarkRunId = makeId;
