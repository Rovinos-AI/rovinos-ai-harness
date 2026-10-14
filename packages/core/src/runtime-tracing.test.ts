// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, diag, isSpanContextValid, trace } from "@opentelemetry/api";
import {
  FakeClock,
  Id,
  RunConfigSchema,
  SequentialIdGenerator,
  Sha256Hex,
  type Event as HarnessEvent,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import {
  createTestContextManager,
  createTestSpanCollector,
  createTestTracerProvider,
} from "@harness/telemetry/testing";
import * as telemetry from "@harness/telemetry";
import { SqliteVault, VaultOperationError } from "@harness/vault";
import { describe, expect, it, vi } from "vitest";
import { RunRecorder } from "./recorder.js";
import { createRuntime as createRuntimeImpl } from "./runtime.js";
import { RUN_SPAN } from "./spans.js";
import { FakeModelPort } from "./testing/fake-model.js";
import type {
  ModelCompletion,
  ModelPort,
  PolicyPort,
  RunContext,
  ToolExecutionResult,
  ToolPort,
} from "./ports.js";
import type { ShutdownProcessLike } from "./shutdown.js";

const createRuntime = (
  config: Parameters<typeof createRuntimeImpl>[0],
  overrides: Parameters<typeof createRuntimeImpl>[1] = {},
) => createRuntimeImpl(config, { ...overrides, transientVault: true });

const config = { run: RunConfigSchema.parse({}) };
const allowPolicy: PolicyPort = {
  version: "runtime-tracing-test",
  decide: () => ({ decision: "allow", ruleId: "test_allow", reason: "test_allow", editable: [] }),
};

function completion(): ModelCompletion {
  return {
    parts: [{ type: "text", text: "answer" }],
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "stop",
    provider: "test",
    model: "test",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

class TestShutdownProcess implements ShutdownProcessLike {
  exitCode: number | undefined;
  private readonly listeners = new Map<"SIGINT" | "SIGTERM", (() => void)[]>();

  on(signal: "SIGINT" | "SIGTERM", listener: () => void): this {
    this.listeners.set(signal, [...(this.listeners.get(signal) ?? []), listener]);
    return this;
  }

  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): this {
    this.listeners.set(
      signal,
      (this.listeners.get(signal) ?? []).filter((registered) => registered !== listener),
    );
    return this;
  }

  exit(code: number): void {
    this.exitCode = code;
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    for (const listener of this.listeners.get(signal) ?? []) {
      listener();
    }
  }
}

async function readRunEvents(store: InMemoryEventStore, runId: Id): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
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

  it("adds bounded policy decisions and rule ids to tool-call spans", async () => {
    trace.disable();
    otelContext.disable();
    const collector = createTestSpanCollector();
    trace.setGlobalTracerProvider(collector.provider);
    otelContext.setGlobalContextManager(createTestContextManager());

    try {
      for (const [index, decision] of (["allow", "ask", "deny"] as const).entries()) {
        const ruleId = `test.${decision}`;
        const runtime = await createRuntime(config, {
          store: new InMemoryEventStore(),
          model: new FakeModelPort([
            {
              ...completion(),
              parts: [
                {
                  type: "tool_call",
                  callId: Id.parse(`${String(index + 2).repeat(26)}`),
                  toolId: "test.tool",
                  args: {},
                },
              ],
            },
          ]),
          policy: {
            version: "runtime_tracing_test",
            decide: () => ({
              decision,
              ruleId,
              reason: "test_reason",
              editable: [],
            }),
          },
          tool: {
            describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
            execute: async () => ({ outcome: "ok", result: null }),
          },
        });

        await runtime.run("goal");
        await runtime.close();

        const decisionSpan = collector
          .getFinishedSpans()
          .find(
            (span) =>
              span.name === "harness.tool_call" &&
              span.attributes["harness.policy.decision"] === decision,
          );
        expect(decisionSpan?.attributes).toMatchObject({
          "harness.policy.decision": decision,
          "harness.policy.rule_id": ruleId,
        });
      }
    } finally {
      await collector.provider.shutdown();
      trace.disable();
      otelContext.disable();
      trace.setGlobalTracerProvider(createTestTracerProvider());
      otelContext.setGlobalContextManager(createTestContextManager());
    }
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

  it("stops reading legacy history after finding the first model-request goal", async () => {
    const store = new InMemoryEventStore();
    const runtime = await createRuntime(config, {
      store,
      model: new FakeModelPort([completion()]),
    });
    const completed = await runtime.run("legacy goal");
    const runId = completed.events[0]?.runId;
    if (runId === undefined) {
      throw new Error("Expected the completed run to include its run id.");
    }

    const read = store.read.bind(store);
    let intercepted = false;
    let readPastRequest = false;
    vi.spyOn(store, "read").mockImplementation((requestedRunId, range) =>
      (async function* () {
        for await (const event of read(requestedRunId, range)) {
          if (!intercepted && range === undefined && event.type === "run_input") {
            continue;
          }
          if (!intercepted && range === undefined && event.type === "model_request") {
            intercepted = true;
            yield event;
            readPastRequest = true;
            throw new Error("Legacy goal scan continued after its first model request.");
          }
          yield event;
        }
      })(),
    );

    await expect(runtime.resume(runId)).rejects.toMatchObject({ code: "run_already_terminal" });
    expect(readPastRequest).toBe(false);
    await runtime.close();
  });

  it("aborts an in-flight tool when another process records cancellation", async () => {
    const markTerminal = vi
      .spyOn(SqliteVault.prototype, "markTerminal")
      .mockRejectedValue(new VaultOperationError("vault_unavailable"));
    const logFailure = vi.spyOn(telemetry, "emitVaultMarkTerminalFailed");
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
        parts: [
          ...completion().parts,
          {
            type: "tool_call",
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
      policy: allowPolicy,
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
    expect(logFailure).toHaveBeenCalledWith(runId, "vault_unavailable");
    expect(markTerminal).toHaveBeenCalled();
    await runtime.close();
    markTerminal.mockRestore();
    logFailure.mockRestore();
  });

  it("returns a completed run when terminal vault marking fails", async () => {
    const markTerminal = vi
      .spyOn(SqliteVault.prototype, "markTerminal")
      .mockRejectedValue(new VaultOperationError("vault_unavailable"));
    const logFailure = vi.spyOn(telemetry, "emitVaultMarkTerminalFailed");
    const runtime = await createRuntime(config, {
      store: new InMemoryEventStore(),
      model: new FakeModelPort([completion()]),
    });

    const result = await runtime.run("goal");
    const runId = result.events[0]?.runId;
    if (runId === undefined) {
      throw new Error("Expected the completed run to include its run id.");
    }

    expect(result.status).toBe("completed");
    expect(logFailure).toHaveBeenCalledWith(runId, "vault_unavailable");
    await runtime.close();
    markTerminal.mockRestore();
    logFailure.mockRestore();
  });

  it("returns cancelled when shutdown aborts before cancellation is observed", async () => {
    const store = new InMemoryEventStore();
    const shutdown = new TestShutdownProcess();
    let signalToolStarted: () => void = () => undefined;
    let signalCancellationObserved: () => void = () => undefined;
    let resolveTool: (result: ToolExecutionResult) => void = () => undefined;
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });
    const cancellationObserved = new Promise<void>((resolve) => {
      signalCancellationObserved = resolve;
    });
    const read = store.read.bind(store);
    vi.spyOn(store, "read").mockImplementation((runId, range) =>
      (async function* () {
        for await (const event of read(runId, range)) {
          const isCancellation = event.type === "run_status_changed" && event.to === "cancelled";
          yield event;
          if (isCancellation) {
            signalCancellationObserved();
          }
        }
      })(),
    );
    const tool: ToolPort = {
      describe: () => ({ idempotent: false, timeoutMs: 60_000 }),
      execute: () =>
        new Promise<ToolExecutionResult>((resolve) => {
          resolveTool = resolve;
          signalToolStarted();
        }),
    };
    const model = new FakeModelPort([
      {
        ...completion(),
        parts: [
          ...completion().parts,
          {
            type: "tool_call",
            callId: Id.parse("22222222222222222222222222"),
            toolId: "slow_tool",
            args: {},
          },
        ],
      },
    ]);
    const runtime = await createRuntime(config, {
      store,
      ids: new SequentialIdGenerator(),
      model,
      policy: allowPolicy,
      tool,
      processLike: shutdown,
    });
    const runId = Id.parse("00000000000000000000000000");
    const running = runtime.run("goal");
    await toolStarted;
    shutdown.emit("SIGTERM");

    await expect(runtime.cancel(runId)).resolves.toBe("cancelled");
    await cancellationObserved;
    resolveTool({ outcome: "ok", result: null });
    const result = await running;
    const events = await readRunEvents(store, runId);
    const cancelEvent = events.find(
      (event) => event.type === "run_status_changed" && event.to === "cancelled",
    );

    expect(result.status).toBe("cancelled");
    expect(cancelEvent).toBeDefined();
    expect(events.at(-1)).toEqual(cancelEvent);
    expect(events.some((event) => event.type === "tool_result")).toBe(false);
    await runtime.close();
  });

  it("continues after transient monitor read failures and detects a later cancellation", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(1_000);
    const diagnosticWarnings: unknown[][] = [];
    diag.disable();
    diag.setLogger({
      error: () => undefined,
      warn: (...args: unknown[]) => {
        diagnosticWarnings.push(args);
      },
      info: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
    });
    let readAttempts = 0;
    let signalReadsRecovered: () => void = () => undefined;
    let releaseFirstCompletion: () => void = () => undefined;
    let signalToolStarted: () => void = () => undefined;
    const readsRecovered = new Promise<void>((resolve) => {
      signalReadsRecovered = resolve;
    });
    const firstCompletion = new Promise<void>((resolve) => {
      releaseFirstCompletion = resolve;
    });
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });
    const read = store.read.bind(store);
    vi.spyOn(store, "read").mockImplementation((runId, range) =>
      (async function* () {
        readAttempts += 1;
        if (readAttempts <= 2) {
          throw new Error("transient store failure");
        }
        for await (const event of read(runId, range)) {
          yield event;
        }
        if (readAttempts === 3) {
          signalReadsRecovered();
        }
      })(),
    );
    let modelCalls = 0;
    const model: ModelPort = {
      complete: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          await firstCompletion;
          return completion();
        }
        return {
          ...completion(),
          parts: [
            ...completion().parts,
            {
              type: "tool_call",
              callId: Id.parse("22222222222222222222222222"),
              toolId: "slow_tool",
              args: {},
            },
          ],
        };
      },
    };
    const tool: ToolPort = {
      describe: () => ({ idempotent: false, timeoutMs: 60_000 }),
      execute: (_call, { signal }) =>
        new Promise<ToolExecutionResult>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("tool cancelled"));
            },
            { once: true },
          );
          signalToolStarted();
        }),
    };
    const runtime = await createRuntime(config, {
      store,
      clock,
      ids: new SequentialIdGenerator(),
      model,
      policy: allowPolicy,
      tool,
    });
    const firstRun = runtime.run("first");

    await readsRecovered;
    releaseFirstCompletion();
    const firstResult = await firstRun;
    expect(firstResult.status).toBe("completed");
    expect(readAttempts).toBe(3);
    expect(diagnosticWarnings).toEqual([
      ["harness.core", "keys_ephemeral"],
      ["harness.core", "cancel_monitor_degraded"],
      ["harness.core", "cancel_monitor_degraded"],
    ]);

    const secondRun = runtime.run("second");
    await toolStarted;
    const activeRuns = await store.listRuns({ status: "running", limit: 10 });
    const secondRunId = activeRuns.runs.find(
      (summary) => summary.runId !== firstResult.events[0]?.runId,
    )?.runId;
    if (secondRunId === undefined) {
      throw new Error("Expected the second run to be active.");
    }

    await expect(runtime.cancel(secondRunId)).resolves.toBe("cancelled");
    expect((await secondRun).status).toBe("cancelled");
    expect(readAttempts).toBeGreaterThan(3);
    await runtime.close();
    diag.disable();
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
              messages: [],
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
