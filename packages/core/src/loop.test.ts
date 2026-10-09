// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  context,
  ROOT_CONTEXT,
  trace,
  SpanStatusCode,
  type Context,
  type ContextManager,
  type Span,
  type SpanContext,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import {
  FakeClock,
  JsonValue,
  SequentialIdGenerator,
  HarnessError,
  type Event,
  type JsonValue as JsonValueType,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { FakeModelPort, FakeToolPort } from "./testing/index.js";
import { NaiveContext } from "./context/naive-context.js";
import { RunRecorder } from "./recorder.js";
import { runLoop } from "./loop.js";
import type { ModelCompletion, ModelPort } from "./ports.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const configHash = "a".repeat(64);
const modelCallId = "22222222222222222222222222";
const goldenPath = fileURLToPath(new URL("./__golden__/one-step.json", import.meta.url));
let nextSpanId = 0;

class TestSpan implements Span {
  private ended = false;
  private recordedExceptions = 0;
  readonly attributes: Record<string, string | number | boolean> = {};
  readonly spanContextValue: SpanContext = {
    traceId: "a".repeat(32),
    spanId: (++nextSpanId).toString(16).padStart(16, "0"),
    traceFlags: 1,
  };

  constructor(
    readonly name: string,
    readonly parentSpanId: string | undefined,
  ) {}

  spanContext(): SpanContext {
    return this.spanContextValue;
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: SpanOptions["attributes"]): this {
    if (attributes !== undefined) {
      Object.assign(this.attributes, attributes);
    }
    return this;
  }

  addEvent(
    _name: Parameters<Span["addEvent"]>[0],
    _attributesOrStartTime?: Parameters<Span["addEvent"]>[1],
    _startTime?: Parameters<Span["addEvent"]>[2],
  ): this {
    return this;
  }

  addLink(_link: Parameters<Span["addLink"]>[0]): this {
    return this;
  }

  addLinks(_links: Parameters<Span["addLinks"]>[0]): this {
    return this;
  }

  status: Parameters<Span["setStatus"]>[0] = { code: SpanStatusCode.UNSET };

  setStatus(status: Parameters<Span["setStatus"]>[0]): this {
    this.status = status;
    return this;
  }

  updateName(_name: string): this {
    return this;
  }

  end(): void {
    this.ended = true;
  }

  isRecording(): boolean {
    return !this.ended;
  }

  recordException(
    _exception: Parameters<Span["recordException"]>[0],
    _time?: Parameters<Span["recordException"]>[1],
  ): void {
    this.recordedExceptions += 1;
  }
}

class TestTracer implements Tracer {
  readonly spans: TestSpan[] = [];

  startSpan(name: string, _options?: SpanOptions, parentContext?: Context): Span {
    const parent = trace.getSpan(parentContext ?? context.active());
    const span = new TestSpan(name, parent?.spanContext().spanId);
    this.spans.push(span);
    return span;
  }

  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    activeContext: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    _name: string,
    _optionsOrCallback: SpanOptions | F,
    _contextOrCallback?: Context | F,
    _callback?: F,
  ): ReturnType<F> {
    throw new Error("startActiveSpan is not used by the recorder.");
  }
}

class TestTracerProvider implements TracerProvider {
  private readonly tracer = new TestTracer();

  getTracer(): Tracer {
    return this.tracer;
  }

  get spans(): readonly TestSpan[] {
    return this.tracer.spans;
  }
}

class TestContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(activeContext, () => fn.apply(thisArg, args));
  }

  bind<T>(_activeContext: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }
}

function completion(
  toolCalls: ModelCompletion["toolCalls"] = [],
  content = "answer",
): ModelCompletion {
  return {
    content,
    toolCalls,
    usage: { inputTokens: 3, outputTokens: 5, costMicros: 12 },
    finishReason: "stop",
    provider: "test_provider",
    model: "test_model",
    latencyMs: 8,
    schemaValid: true,
    repairAttempts: 0,
    providerBlobs: { trace: "opaque" },
  };
}

class TestToolError extends HarnessError {
  readonly code = "tool_broken";

  constructor() {
    super("Synthetic tool failure.");
  }
}

function normalizeEvents(events: readonly Event[]): JsonValueType {
  return events.map((event) => {
    if (event.type === "run_created") {
      return {
        type: event.type,
        seq: event.seq,
        configHash: event.configHash,
        policyVersion: event.policyVersion,
      };
    }
    if (event.type === "run_status_changed") {
      return {
        type: event.type,
        seq: event.seq,
        from: event.from,
        to: event.to,
        reason: event.reason,
      };
    }
    if (event.type === "model_request") {
      return {
        type: event.type,
        seq: event.seq,
        requestId: event.requestId,
        provider: event.provider,
        model: event.model,
        messages: event.messages,
      };
    }
    if (event.type === "model_response") {
      return {
        type: event.type,
        seq: event.seq,
        requestId: event.requestId,
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        finishReason: event.finishReason,
        latencyMs: event.latencyMs,
        schemaValid: event.schemaValid,
        repairAttempts: event.repairAttempts,
        content: event.content,
        providerBlobs: event.providerBlobs,
      };
    }
    return { type: event.type, seq: event.seq };
  });
}

const tracerProvider = new TestTracerProvider();

beforeAll(() => {
  context.setGlobalContextManager(new TestContextManager());
  trace.setGlobalTracerProvider(tracerProvider);
});

afterAll(() => {
  context.disable();
});

describe("runLoop", () => {
  it("completes a scripted one-step run with a deterministic golden event sequence", async () => {
    const startingSpanIndex = tracerProvider.spans.length;
    const store = new InMemoryEventStore();
    const append = vi.spyOn(store, "append");
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const ids = new SequentialIdGenerator();
    const signal = new AbortController().signal;
    const model = new FakeModelPort([completion()]);
    const complete = model.complete.bind(model);
    vi.spyOn(model, "complete").mockImplementation(async (request, callContext) => {
      const durableTypes: string[] = [];
      for await (const event of store.read(runId)) {
        durableTypes.push(event.type);
      }
      expect(durableTypes.at(-1)).toBe("model_request");
      return complete(request, callContext);
    });
    const contextPort = { build: vi.fn(() => Promise.resolve(["prior context"])) };
    const result = await runLoop({
      recorder,
      clock,
      model,
      tool: new FakeToolPort(),
      context: contextPort,
      ids,
      goal: "test goal",
      configHash,
      policyVersion: "test.policy",
      signal,
      role: "assistant",
      provider: "test_provider",
      modelName: "test_model",
    });

    expect(result.state.status).toBe("completed");
    expect(result.state.steps).toBe(1);
    expect(result.state.usage).toEqual({ inputTokens: 3, outputTokens: 5, costMicros: 0 });
    expect(result.events.map(({ type }) => type)).toEqual([
      "run_created",
      "run_status_changed",
      "model_request",
      "model_response",
      "run_status_changed",
    ]);
    expect(contextPort.build).toHaveBeenCalledWith(result.events.slice(0, 2));
    expect(append.mock.calls.map(([, , expectedSeq]) => expectedSeq)).toEqual([0, 2, 3, 4]);
    expect(model.requests).toEqual([
      {
        request: {
          requestId: "00000000000000000000000000",
          messages: { goal: "test goal", context: ["prior context"] },
          role: "assistant",
        },
        context: { runId, signal },
      },
    ]);
    expect(await store.head(runId)).toBe(5);
    const spans = tracerProvider.spans.slice(startingSpanIndex);
    const runSpans = spans.filter(({ name }) => name === "harness.run");
    const modelSpans = spans.filter(({ name }) => name === "harness.model_call");
    expect(runSpans).toHaveLength(1);
    expect(modelSpans).toHaveLength(1);
    expect(modelSpans[0]?.parentSpanId).toBe(runSpans[0]?.spanContextValue.spanId);
    expect(runSpans[0]?.attributes["harness.event.seq"]).toBe(4);

    const actual = `${JSON.stringify(normalizeEvents(result.events), null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === "1") {
      await writeFile(goldenPath, actual);
    }
    const goldenInput: unknown = JSON.parse(await readFile(goldenPath, "utf8"));
    expect(JsonValue.parse(goldenInput)).toEqual(normalizeEvents(result.events));
  });

  it("durably records tool intent and feeds tool results into the next model request", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const signal = new AbortController().signal;
    let intentWasDurable = false;
    const call = {
      callId: modelCallId,
      toolId: "test_tool",
      args: { z: 1, a: { z: 2, a: 3 } },
    };
    const tool = new FakeToolPort(
      new Map([
        [
          "test_tool",
          {
            idempotent: true,
            timeoutMs: 1000,
            execute: async () => {
              const types: string[] = [];
              for await (const event of store.read(runId)) {
                types.push(event.type);
              }
              intentWasDurable = types.at(-1) === "tool_intent";
              expect(intentWasDurable).toBe(true);
              clock.advance(7);
              return { outcome: "ok", result: { value: "tool output" } };
            },
          },
        ],
      ]),
    );
    const model = new FakeModelPort([
      completion([call], "tool request"),
      completion([], "final answer"),
    ]);
    const result = await runLoop({
      recorder,
      clock,
      model,
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "tool goal",
      configHash,
      policyVersion: "test.policy",
      signal,
    });

    expect(intentWasDurable).toBe(true);
    expect(result.state.status).toBe("completed");
    expect(result.events.map(({ type }) => type)).toEqual([
      "run_created",
      "run_status_changed",
      "model_request",
      "model_response",
      "tool_intent",
      "tool_result",
      "model_request",
      "model_response",
      "run_status_changed",
    ]);
    expect(result.events.find(({ type }) => type === "tool_result")).toMatchObject({
      outcome: "ok",
      result: { value: "tool output" },
      latencyMs: 7,
    });
    expect(result.events.find(({ type }) => type === "tool_intent")).toMatchObject({
      argsHash: "e634af6ecfc23845fdae9c393661c63b99ad304d3f05a08faab28727c785d718",
    });
    expect(model.requests[1]?.request.messages).toEqual({
      goal: "tool goal",
      context: ["tool request", { value: "tool output" }],
    });
    expect(tool.calls).toHaveLength(1);
  });

  it("denies unknown tools without executing them", async () => {
    const clock = new FakeClock(100);
    const tool = new FakeToolPort();
    const result = await runLoop({
      recorder: new RunRecorder(new InMemoryEventStore(), runId, segmentId, 0, clock),
      clock,
      model: new FakeModelPort([
        completion([{ callId: modelCallId, toolId: "unknown_tool", args: {} }]),
        completion(),
      ]),
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "unknown tool goal",
      configHash,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("completed");
    expect(tool.calls).toEqual([]);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_intent",
        toolId: "unknown_tool",
        idempotent: false,
        policyDecision: "deny",
      }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolId: "unknown_tool",
        outcome: "denied",
        errorCode: "unknown_tool",
      }),
    );
  });

  it("records timeouts and allows the model to continue", async () => {
    const clock = new FakeClock(100);
    const tool = new FakeToolPort(
      new Map([
        [
          "slow_tool",
          {
            idempotent: false,
            timeoutMs: 1,
            execute: (_call, { signal }) =>
              new Promise<never>((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    reject(new Error("Aborted."));
                  },
                  { once: true },
                );
              }),
          },
        ],
      ]),
    );
    const result = await runLoop({
      recorder: new RunRecorder(new InMemoryEventStore(), runId, segmentId, 0, clock),
      clock,
      model: new FakeModelPort([
        completion([{ callId: modelCallId, toolId: "slow_tool", args: {} }]),
        completion(),
      ]),
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "timeout goal",
      configHash,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("completed");
    const toolResult = result.events.find(
      (event): event is Extract<Event, { type: "tool_result" }> => event.type === "tool_result",
    );
    expect(toolResult).toMatchObject({
      outcome: "timeout",
      errorCode: "tool_timeout",
      result: null,
    });
    expect(toolResult?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("maps returned tool errors and thrown errors to stable result codes", async () => {
    const clock = new FakeClock(100);
    const tool = new FakeToolPort(
      new Map([
        [
          "returned_error",
          {
            idempotent: true,
            timeoutMs: 1000,
            execute: () =>
              Promise.resolve({
                outcome: "error",
                errorCode: "tool_rejected",
                result: { reason: "rejected" },
              }),
          },
        ],
        [
          "harness_error",
          {
            idempotent: true,
            timeoutMs: 1000,
            execute: () => Promise.reject(new TestToolError()),
          },
        ],
        [
          "unknown_error",
          {
            idempotent: true,
            timeoutMs: 1000,
            execute: () => Promise.reject(new Error("Synthetic failure.")),
          },
        ],
      ]),
    );
    const result = await runLoop({
      recorder: new RunRecorder(new InMemoryEventStore(), runId, segmentId, 0, clock),
      clock,
      model: new FakeModelPort([
        completion([
          { callId: modelCallId, toolId: "returned_error", args: {} },
          { callId: "33333333333333333333333333", toolId: "harness_error", args: {} },
          { callId: "44444444444444444444444444", toolId: "unknown_error", args: {} },
        ]),
        completion(),
      ]),
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "tool error goal",
      configHash,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("completed");
    expect(
      result.events
        .filter((event) => event.type === "tool_result")
        .map((event) => [event.outcome, event.errorCode]),
    ).toEqual([
      ["error", "tool_rejected"],
      ["error", "tool_broken"],
      ["error", "tool_failed"],
    ]);
  });

  it.each([
    [
      Object.assign(new Error("provider failure"), { code: "provider_unavailable" }),
      "provider_unavailable",
    ],
    [Object.assign(new Error("provider failure"), { code: "Invalid Code" }), "model_failed"],
    [new Error("provider detail"), "model_failed"],
  ])("records a failed status when the model port rejects", async (error, expectedCode) => {
    const startingSpanIndex = tracerProvider.spans.length;
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(new InMemoryEventStore(), runId, segmentId, 0, clock);
    const model: ModelPort = {
      complete() {
        return Promise.reject(error);
      },
    };
    const result = await runLoop({
      recorder,
      clock,
      model,
      tool: new FakeToolPort(),
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "error goal",
      configHash,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("failed");
    expect(result.events.at(-1)).toMatchObject({
      type: "run_status_changed",
      from: "running",
      to: "failed",
      reason: expectedCode,
    });
    const spans = tracerProvider.spans.slice(startingSpanIndex);
    const runSpan = spans.find(({ name }) => name === "harness.run");
    const modelSpan = spans.find(({ name }) => name === "harness.model_call");
    expect(modelSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(modelSpan?.attributes["harness.error.code"]).toBe(expectedCode);
    expect(runSpan?.attributes["harness.event.seq"]).toBe(3);
  });
});
