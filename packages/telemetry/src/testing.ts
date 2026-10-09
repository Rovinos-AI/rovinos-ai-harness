// SPDX-License-Identifier: Apache-2.0
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

/** Creates a no-export tracer provider with deterministic identifiers for tests. */
export function createTestTracerProvider(): BasicTracerProvider {
  return new BasicTracerProvider({
    idGenerator: {
      generateTraceId: () => "a".repeat(32),
      generateSpanId: () => "b".repeat(16),
    },
  });
}

/** Creates an enabled async-local context manager for tests. */
export function createTestContextManager(): AsyncLocalStorageContextManager {
  return new AsyncLocalStorageContextManager().enable();
}
