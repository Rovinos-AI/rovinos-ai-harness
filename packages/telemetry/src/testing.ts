// SPDX-License-Identifier: Apache-2.0
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { Id, VaultValueEntry } from "@harness/schemas";
import type { VaultRunReader } from "./sentinel/run-values.js";

/** Creates a no-export tracer provider with deterministic identifiers for tests. */
export function createTestTracerProvider(): BasicTracerProvider {
  return new BasicTracerProvider({
    idGenerator: {
      generateTraceId: () => "a".repeat(32),
      generateSpanId: () => "b".repeat(16),
    },
  });
}

/** Creates a deterministic tracer provider that retains finished spans for assertions. */
export function createTestSpanCollector(): {
  readonly provider: BasicTracerProvider;
  getFinishedSpans: () => ReturnType<InMemorySpanExporter["getFinishedSpans"]>;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    idGenerator: {
      generateTraceId: () => "a".repeat(32),
      generateSpanId: () => "b".repeat(16),
    },
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return {
    provider,
    getFinishedSpans: () => exporter.getFinishedSpans(),
  };
}

/** In-memory metric provider for integration tests that inspect exported counters. */
export interface TestMetricCollector {
  readonly provider: MeterProvider;
  getMetrics(): ResourceMetrics[];
  forceFlush(): Promise<void>;
}

/** Creates a metric provider whose reader exports snapshots to an in-memory exporter. */
export function createTestMetricCollector(): TestMetricCollector {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    provider,
    getMetrics: () => exporter.getMetrics(),
    forceFlush: () => provider.forceFlush(),
  };
}

/** Creates an enabled async-local context manager for tests. */
export function createTestContextManager(): AsyncLocalStorageContextManager {
  return new AsyncLocalStorageContextManager().enable();
}

/** Read-only vault fixture backed by a fixed map of run IDs to raw values. */
export class StaticVaultReader implements VaultRunReader {
  private readonly valuesByRun: ReadonlyMap<Id, readonly VaultValueEntry[]>;

  /** @param valuesByRun Typed vault entries returned for each requested run. */
  constructor(valuesByRun: ReadonlyMap<Id, readonly VaultValueEntry[]>) {
    this.valuesByRun = new Map(
      [...valuesByRun].map(
        ([runId, values]) =>
          [runId, Object.freeze(values.map((entry) => Object.freeze({ ...entry })))] as const,
      ),
    );
  }

  /** Return the fixture's detached value list. */
  listRawValues(runId: Id): Promise<readonly string[]> {
    return Promise.resolve((this.valuesByRun.get(runId) ?? []).map(({ rawValue }) => rawValue));
  }

  /** Return the fixture's detached typed value list. */
  listRawValueEntries(runId: Id): Promise<readonly VaultValueEntry[]> {
    return Promise.resolve((this.valuesByRun.get(runId) ?? []).map((entry) => ({ ...entry })));
  }

  /** Return the fixed number of fixture values for this run. */
  version(runId: Id): Promise<number> {
    return Promise.resolve(this.valuesByRun.get(runId)?.length ?? 0);
  }
}

export {
  assertRandomStringsDroppedFromLog,
  assertRandomStringsDroppedFromSpan,
  assertRegisteredSchemasSafe,
  assertSchemaCatalogSafe,
} from "./testing/registry-lint.js";
export { __registerUnsafeSpanForTests } from "./registry.js";
