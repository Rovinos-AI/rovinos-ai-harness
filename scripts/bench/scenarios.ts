// SPDX-License-Identifier: Apache-2.0
import { cpus, totalmem } from "node:os";
import { SqliteEventStore } from "@rovinos/store-sqlite";
import { PostgresEventStore } from "@rovinos/store-postgres";
import { BenchmarkResultSchema, type BenchmarkResult } from "./contracts.ts";
import { BENCHMARK_PROFILES, type BenchmarkProfile } from "./profiles.ts";
import {
  appendBenchmarks,
  sentinelBenchmarks,
  storeReadAndResumeBenchmarks,
  tokenizerBenchmark,
} from "./store-scenarios.ts";
import { allowlistSentinelBenchmark, queueBenchmark, sdkBenchmarks } from "./service-scenarios.ts";
import { mcpBenchmarks } from "./mcp-scenarios.ts";

export { BENCHMARK_PROFILES };

/** Runs all benchmark scenarios and captures the machine and sample metadata. */
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
  return BenchmarkResultSchema.parse({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    environment: {
      runner:
        process.env.GITHUB_ACTIONS === "true"
          ? "ubuntu-24.04"
          : (process.env.BENCH_RUNNER ?? "local"),
      platform: process.platform,
      architecture: process.arch,
      cpu: cpu?.model ?? "unknown",
      cpuCount: Math.max(1, cpus().length),
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
