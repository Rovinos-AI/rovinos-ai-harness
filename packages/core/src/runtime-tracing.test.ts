// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, diag, isSpanContextValid, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { FakeClock, Id, RunConfigSchema, Sha256Hex } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { describe, expect, it, vi } from "vitest";
import { RunRecorder } from "./recorder.js";
import { createRuntime } from "./runtime.js";
import { RUN_SPAN } from "./spans.js";
import { FakeModelPort } from "./testing/fake-model.js";

const config = { run: RunConfigSchema.parse({}) };

function completion() {
  return {
    content: "answer",
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "stop",
    provider: "test",
    model: "test",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    providerBlobs: null,
  } as const;
}

describe("runtime tracing fallback", () => {
  it("keeps an existing provider and context manager, then installs a fallback once", async () => {
    trace.disable();
    otelContext.disable();
    diag.disable();

    const existingProvider = new BasicTracerProvider({
      idGenerator: {
        generateTraceId: () => "a".repeat(32),
        generateSpanId: () => "b".repeat(16),
      },
    });
    trace.setGlobalTracerProvider(existingProvider);
    otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const setContextManager = vi.spyOn(otelContext, "setGlobalContextManager");

    const runtimeWithProvider = await createRuntime(config, {
      store: new InMemoryEventStore(),
      model: new FakeModelPort([completion()]),
    });
    const providerResult = await runtimeWithProvider.run("goal");

    expect(providerResult.status).toBe("completed");
    expect(providerResult.events.length).toBeGreaterThan(0);
    expect(providerResult.events.every((event) => event.traceId === "a".repeat(32))).toBe(true);
    expect(setContextManager).not.toHaveBeenCalled();
    await runtimeWithProvider.close();
    setContextManager.mockRestore();
    await existingProvider.shutdown();

    trace.disable();
    otelContext.disable();
    const diagnosticErrors: unknown[][] = [];
    diag.setLogger({
      error: (...args: unknown[]) => {
        diagnosticErrors.push(args);
      },
    });
    const setTracerProvider = vi.spyOn(trace, "setGlobalTracerProvider");
    const setFallbackContextManager = vi.spyOn(otelContext, "setGlobalContextManager");
    const first = await createRuntime(config, { store: new InMemoryEventStore() });
    const second = await createRuntime(config, { store: new InMemoryEventStore() });

    expect(setTracerProvider).toHaveBeenCalledTimes(1);
    expect(setFallbackContextManager).toHaveBeenCalledTimes(1);
    expect(diagnosticErrors).toEqual([]);

    let activeContextIsValid = false;
    trace.getTracer("runtime-tracing-test").startActiveSpan("test", (span) => {
      activeContextIsValid = isSpanContextValid(span.spanContext());
      span.end();
    });
    expect(activeContextIsValid).toBe(true);

    await first.close();
    await second.close();
    setTracerProvider.mockRestore();
    setFallbackContextManager.mockRestore();
    diag.disable();
  });

  it("fails closed when a resumable run has no recorded model request", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(1_000);
    const runId = Id.parse("00000000000000000000000000");
    const recorder = new RunRecorder(
      store,
      runId,
      Id.parse("00000000000000000000000001"),
      0,
      clock,
    );
    await recorder.withStepSpan(RUN_SPAN, {}, async () => {
      const events = await recorder.recordBatch([
        {
          type: "run_created",
          v: 1,
          configHash: Sha256Hex.parse("a".repeat(64)),
          policyVersion: "test",
        },
        {
          type: "run_status_changed",
          v: 1,
          from: "pending",
          to: "running",
          reason: "start",
        },
      ]);
      const lastEvent = events.at(-1);
      if (lastEvent === undefined) {
        throw new Error("Expected a seeded run status event.");
      }
      return lastEvent;
    });
    const runtime = await createRuntime(config, { store, clock });
    const headBeforeResume = await store.head(runId);

    await expect(runtime.resume(runId)).rejects.toMatchObject({ code: "run_input_missing" });
    expect(await store.head(runId)).toBe(headBeforeResume);
    await runtime.close();
  });
});
