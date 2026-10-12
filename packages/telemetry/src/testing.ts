// SPDX-License-Identifier: Apache-2.0
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { Id } from "@harness/schemas";
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

/** Creates an enabled async-local context manager for tests. */
export function createTestContextManager(): AsyncLocalStorageContextManager {
  return new AsyncLocalStorageContextManager().enable();
}

/** Read-only vault fixture backed by a fixed map of run IDs to raw values. */
export class StaticVaultReader implements VaultRunReader {
  private readonly valuesByRun: ReadonlyMap<Id, readonly string[]>;

  /** @param valuesByRun Values returned for each requested run. */
  constructor(valuesByRun: ReadonlyMap<Id, readonly string[]>) {
    this.valuesByRun = new Map(
      [...valuesByRun].map(([runId, values]) => [runId, Object.freeze([...values])]),
    );
  }

  /** Return the fixture's detached value list. */
  listRawValues(runId: Id): Promise<readonly string[]> {
    return Promise.resolve([...(this.valuesByRun.get(runId) ?? [])]);
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
