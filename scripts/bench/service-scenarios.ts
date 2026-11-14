// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@rovinos/config";
import { RUN_SPAN } from "@rovinos/core";
import { InMemoryEventStore, type EventStore } from "@rovinos/store";
import { SqliteRunQueue } from "@rovinos/store-sqlite";
import { Principal, type Id } from "@rovinos/schemas";
import { createHarness } from "@rovinos/sdk";
import { AllowlistSpanProcessor, SentinelGate, TripQueue, VaultRunView } from "@rovinos/telemetry";
import { createTestReadableSpan, StaticVaultReader } from "@rovinos/telemetry/testing";
import type { BenchmarkResult } from "./contracts.ts";
import {
  appendInputBatch,
  approvalRequested,
  makeId,
  measure,
  metric,
  runCreated,
  spanId,
  statusChange,
  syntheticVaultValues,
  traceId,
  type BenchmarkProfile,
} from "./common.ts";
import { MAX_LOG_EVENTS } from "./common.ts";

/** Measures allowlist sanitization plus sentinel checking for each span. */
export async function allowlistSentinelBenchmark(
  profile: BenchmarkProfile,
): Promise<BenchmarkResult["metrics"][number]> {
  const runId = makeId(600);
  const reader = new StaticVaultReader(new Map([[runId, syntheticVaultValues(100)]]));
  const gate = new SentinelGate(new VaultRunView(reader), undefined, {
    tripQueue: new TripQueue({ emit: () => undefined, enabled: () => true }),
  });
  const processor = new AllowlistSpanProcessor(
    {
      onStart: () => undefined,
      onEnd: () => undefined,
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    { gate },
  );
  const result = await measure(
    "telemetry.allowlist_sentinel",
    async () => {
      const span = RUN_SPAN.start({
        "harness.run.id": runId,
        "harness.segment.id": runId,
        "harness.run.depth": 0,
      });
      const attributes = {
        "harness.run.id": runId,
        "harness.segment.id": runId,
        "harness.run.depth": 0,
      };
      const readableSpan = createTestReadableSpan(span, RUN_SPAN.name, attributes, {
        traceId,
        spanId,
        traceFlags: 1,
        isRemote: false,
      });
      processor.onEnd(readableSpan);
      await processor.forceFlush();
    },
    profile,
  );
  await processor.shutdown();
  return metric(
    "telemetry.allowlist_sentinel.spans",
    result.operationsPerSecond,
    "ops/s",
    result.sampleCount,
  );
}

/** Measures four-worker queue claim throughput. */
export async function queueBenchmark(
  profile: BenchmarkProfile,
): Promise<BenchmarkResult["metrics"][number]> {
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
  return metric("queue.claim.4_workers", result.operationsPerSecond, "ops/s", result.sampleCount);
}

async function createHarnessForBench(store: InMemoryEventStore) {
  return createHarness({
    config: HarnessConfigSchema.parse({}),
    contentAuthorizer: () => true,
    overrides: { store, transientVault: true },
  });
}

async function seedApprovalRuns(store: EventStore, count: number) {
  for (let index = 0; index < count; index += 1) {
    const runId = makeId(20_000 + index);
    const approvalId = makeId(30_000 + index);
    await store.append(
      runId,
      [
        runCreated(runId, index * 4 + 1),
        statusChange(runId, index * 4 + 2, {
          from: "pending",
          to: "running",
          reason: "started",
        }),
        approvalRequested(runId, approvalId, index * 4 + 3),
        statusChange(runId, index * 4 + 4, {
          from: "running",
          to: "suspended",
          reason: "awaiting_approval",
        }),
      ],
      0,
    );
  }
}

async function fullHistoryAndStreamBenchmarks(
  profile: BenchmarkProfile,
  harness: Awaited<ReturnType<typeof createHarnessForBench>>,
  runId: Id,
) {
  const fullHistory = await measure("sdk.full_history", () => harness.getRun(runId), profile);
  const stream = await measure(
    "sdk.content_stream",
    async () => {
      let entries = 0;
      for await (const entry of harness.streamRunContent(runId, {
        principal: Principal.parse("cli.bench"),
      })) {
        entries += Number(Object.keys(entry).length > 0);
        await Promise.resolve();
      }
      return entries;
    },
    profile,
  );
  return { fullHistory, stream };
}

async function approvalLookupBenchmark(
  profile: BenchmarkProfile,
  harness: Awaited<ReturnType<typeof createHarnessForBench>>,
  store: EventStore,
) {
  await seedApprovalRuns(store, profile.name === "nightly" ? 1_000 : 10);
  return measure(
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
}

/** Measures SDK full-history reads, pending-approval lookup, and streaming. */
export async function sdkBenchmarks(
  profile: BenchmarkProfile,
): Promise<BenchmarkResult["metrics"]> {
  const count = profile.name === "nightly" ? MAX_LOG_EVENTS : 25;
  const store = new InMemoryEventStore();
  const runId = makeId(700);
  await store.append(
    runId,
    [
      runCreated(runId, 1),
      statusChange(runId, 2, { from: "pending", to: "running", reason: "started" }),
    ],
    0,
  );
  await appendInputBatch(store, runId, 3, count);
  await store.append(
    runId,
    [statusChange(runId, count + 3, { from: "running", to: "completed", reason: "completed" })],
    count + 2,
  );
  const harness = await createHarnessForBench(store);
  const { fullHistory, stream } = await fullHistoryAndStreamBenchmarks(profile, harness, runId);
  const approvalLookup = await approvalLookupBenchmark(profile, harness, store);
  const result = [
    metric("sdk.full_history.100k", fullHistory.p95Ms, "ms", fullHistory.sampleCount),
    metric(
      "sdk.pending_approval.1000_runs",
      approvalLookup.p95Ms,
      "ms",
      approvalLookup.sampleCount,
    ),
    metric("sdk.content_stream.backpressure", stream.p95Ms, "ms", stream.sampleCount),
  ];
  await harness.close();
  return result;
}
