// SPDX-License-Identifier: Apache-2.0
import { foldRunState } from "@rovinos/core";
import { Tokenizer } from "@rovinos/pii";
import { type EventStore } from "@rovinos/store";
import { SqliteEventStore } from "@rovinos/store-sqlite";
import { PiiPolicySchema, type Id } from "@rovinos/schemas";
import { SentinelGate, TripQueue, VaultRunView } from "@rovinos/telemetry";
import { InMemoryVault } from "@rovinos/vault";
import { StaticVaultReader } from "@rovinos/telemetry/testing";
import {
  makeId,
  MAX_LOG_EVENTS,
  measure,
  metric,
  readEvents,
  runCreated,
  runInput,
  statusChange,
  syntheticVaultValues,
  type BenchmarkProfile,
  traceId,
  spanId,
} from "./common.ts";
import type { BenchmarkResult } from "./contracts.ts";

/** Measures append throughput for one configured event store. */
export async function appendBenchmarks(
  profile: BenchmarkProfile,
  store: EventStore,
  label: "sqlite" | "postgres",
): Promise<BenchmarkResult["metrics"]> {
  const metrics: ReturnType<typeof metric>[] = [];
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

async function seedLongLog(
  store: EventStore,
  runId: Id,
  count: number,
  withSnapshot: boolean,
): Promise<number> {
  await store.append(
    runId,
    [
      runCreated(runId, 1),
      statusChange(runId, 2, { from: "pending", to: "running", reason: "started" }),
    ],
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

/** Measures 100k-event reading/folding and full-log versus snapshot-tail resume. */
export async function storeReadAndResumeBenchmarks(
  profile: BenchmarkProfile,
): Promise<BenchmarkResult["metrics"]> {
  const count = profile.name === "nightly" ? MAX_LOG_EVENTS : 25;
  const store = new SqliteEventStore(":memory:");
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
      for await (const event of store.read(runId, { fromSeq: latest.atSeq + 1 })) {
        countRead += Number(event.seq > latest.atSeq);
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

/** Measures sentinel preparation and scan p95 at increasing vault sizes. */
export async function sentinelBenchmarks(
  profile: BenchmarkProfile,
): Promise<BenchmarkResult["metrics"]> {
  const runId = makeId(400);
  const metrics: ReturnType<typeof metric>[] = [];
  for (const [label, count] of [
    ["1000", profile.name === "nightly" ? 1_000 : 10],
    ["10000", profile.name === "nightly" ? 10_000 : 20],
    ["100000", profile.name === "nightly" ? 100_000 : 30],
  ] as const) {
    const reader = new StaticVaultReader(new Map([[runId, syntheticVaultValues(count)]]));
    const gate = new SentinelGate(new VaultRunView(reader), undefined, {
      maxPrepareMs: 120_000,
      maxScanMs: 120_000,
      tripQueue: new TripQueue({ emit: () => undefined, enabled: () => true }),
    });
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

/** Measures tokenizer throughput over a 1 MiB mixed synthetic text payload. */
export async function tokenizerBenchmark(
  profile: BenchmarkProfile,
): Promise<BenchmarkResult["metrics"][number]> {
  const vault = new InMemoryVault();
  const tokenizer = new Tokenizer({
    vault,
    policy: PiiPolicySchema.parse({}),
    detectors: {
      detect: (text) => {
        const match = /[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/u.exec(text);
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
