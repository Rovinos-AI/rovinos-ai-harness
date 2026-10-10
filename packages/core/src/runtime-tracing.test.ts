// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, diag, isSpanContextValid, trace } from "@opentelemetry/api";
import { FakeClock, Id, RunConfigSchema, SequentialIdGenerator, Sha256Hex } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { createTestContextManager, createTestTracerProvider } from "@harness/telemetry/testing";
import { describe, expect, it, vi } from "vitest";
import { RunRecorder } from "./recorder.js";
import { createRuntime } from "./runtime.js";
import { RUN_SPAN } from "./spans.js";
import { FakeModelPort } from "./testing/fake-model.js";
import type { RunContext, ToolExecutionResult, ToolPort } from "./ports.js";

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

    const existingProvider = createTestTracerProvider();
    trace.setGlobalTracerProvider(existingProvider);
    otelContext.setGlobalContextManager(createTestContextManager());
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
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
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

  it("aborts an in-flight tool when another process records cancellation", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(1_000);
    let signalToolStarted: () => void = () => undefined;
    let signalToolAborted: () => void = () => undefined;
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });
    const toolAborted = new Promise<void>((resolve) => {
      signalToolAborted = resolve;
    });
    const tool: ToolPort = {
      describe: () => ({ idempotent: false, timeoutMs: 60_000 }),
      execute: (_call, { signal }: RunContext) =>
        new Promise<ToolExecutionResult>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              signalToolAborted();
              reject(new Error("tool cancelled"));
            },
            { once: true },
          );
          signalToolStarted();
        }),
    };
    const model = new FakeModelPort([
      {
        ...completion(),
        toolCalls: [
          {
            callId: Id.parse("22222222222222222222222222"),
            toolId: "slow_tool",
            args: {},
          },
        ],
      },
    ]);
    const runtime = await createRuntime(config, {
      store,
      clock,
      ids: new SequentialIdGenerator(),
      model,
      tool,
    });
    const runId = Id.parse("00000000000000000000000000");
    const running = runtime.run("goal");
    await toolStarted;

    await expect(runtime.cancel(runId)).resolves.toBe("cancelled");
    await toolAborted;
    const result = await running;
    const events = [];
    for await (const event of store.read(runId)) {
      events.push(event);
    }
    const cancelEvents = events.filter(
      (event) => event.type === "run_status_changed" && event.to === "cancelled",
    );

    expect(result.status).toBe("cancelled");
    expect(cancelEvents).toHaveLength(1);
    expect(events.at(-1)).toEqual(cancelEvents[0]);
    expect(events.some((event) => event.type === "tool_intent")).toBe(true);
    expect(events.some((event) => event.type === "tool_result")).toBe(false);
    expect(await store.head(runId)).toBe((events.at(-1)?.seq ?? -1) + 1);
    await runtime.close();
  });

  it("does not treat a different worker's append conflict as cancellation", async () => {
    const store = new InMemoryEventStore();
    const append = store.append.bind(store);
    let conflictInjected = false;
    vi.spyOn(store, "append").mockImplementation(async (runId, events, expectedSeq) => {
      if (!conflictInjected && events.some((event) => event.type === "model_request")) {
        conflictInjected = true;
        await append(
          runId,
          [
            {
              type: "model_request",
              v: 1,
              requestId: Id.parse("33333333333333333333333333"),
              provider: "other_worker",
              model: "other_worker",
              messages: null,
              runId,
              ts: 1_001,
              traceId: "a".repeat(32),
              spanId: "b".repeat(16),
              segmentId: Id.parse("00000000000000000000000001"),
            },
          ],
          expectedSeq,
        );
      }
      return append(runId, events, expectedSeq);
    });
    const runtime = await createRuntime(config, {
      store,
      clock: new FakeClock(1_000),
      ids: new SequentialIdGenerator(),
      model: new FakeModelPort([completion()]),
    });

    await expect(runtime.run("goal")).rejects.toMatchObject({ code: "lease_lost" });
    expect(conflictInjected).toBe(true);
    const events = [];
    for await (const event of store.read(Id.parse("00000000000000000000000000"))) {
      events.push(event);
    }
    expect(
      events.some((event) => event.type === "run_status_changed" && event.to === "cancelled"),
    ).toBe(false);
    await runtime.close();
  });
});
