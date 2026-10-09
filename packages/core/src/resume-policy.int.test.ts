// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  ROOT_CONTEXT,
  trace,
  type Context,
  type ContextManager,
  type Span,
  type SpanContext,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import { FakeClock, SequentialIdGenerator, type Event } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foldRunState, type ToolIntentEvent } from "./run-state.js";
import { RunRecorder } from "./recorder.js";
import { planDanglingIntents } from "./resume-policy.js";
import { applyDanglingIntentAction, executeApprovedDanglingIntent } from "./steps/tool-step.js";
import { FakeToolPort } from "./testing/index.js";
import { RUN_SPAN } from "./spans.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const callId = "22222222222222222222222222";
const configHash = "a".repeat(64);
let nextSpanId = 0;

class TestSpan implements Span {
  private ended = false;
  private readonly value: SpanContext = {
    traceId: "a".repeat(32),
    spanId: (++nextSpanId).toString(16).padStart(16, "0"),
    traceFlags: 1,
  };

  spanContext(): SpanContext {
    return this.value;
  }

  setAttribute(_key: string, _value: string | number | boolean): this {
    return this;
  }

  setAttributes(_attributes: SpanOptions["attributes"]): this {
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

  setStatus(_status: Parameters<Span["setStatus"]>[0]): this {
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
    return;
  }
}

class TestTracer implements Tracer {
  startSpan(_name: string, _options?: SpanOptions, _parentContext?: Context): Span {
    return new TestSpan();
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
    throw new Error("Active spans are not used in this test.");
  }
}

class TestTracerProvider implements TracerProvider {
  getTracer(): Tracer {
    return new TestTracer();
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

beforeAll(() => {
  context.setGlobalContextManager(new TestContextManager());
  trace.setGlobalTracerProvider(new TestTracerProvider());
});

afterAll(() => {
  context.disable();
});

async function createDanglingIntent(
  recorder: RunRecorder,
  idempotent: boolean,
): Promise<{ readonly events: Event[]; readonly intent: ToolIntentEvent }> {
  let events: Event[] = [];
  await recorder.withStepSpan(RUN_SPAN, {}, async () => {
    events = await recorder.recordBatch([
      { type: "run_created", v: 1, configHash, policyVersion: "test.policy" },
      { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
      {
        type: "tool_intent",
        v: 1,
        callId,
        toolId: "resume_tool",
        idempotent,
        policyDecision: "allow",
        argsHash: "d".repeat(64),
        args: { value: 1 },
      },
    ]);
    const last = events.at(-1);
    if (last === undefined) {
      throw new Error("Expected a dangling tool intent.");
    }
    return last;
  });
  const last = events.at(-1);
  if (last?.type !== "tool_intent") {
    throw new Error("Expected a dangling tool intent.");
  }
  return { events, intent: last };
}

describe("dangling tool intent resume", () => {
  it("re-runs idempotent calls once with the original callId and no new intent", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const { events, intent } = await createDanglingIntent(recorder, true);
    const tool = new FakeToolPort(
      new Map([
        [
          "resume_tool",
          {
            idempotent: true,
            timeoutMs: 1_000,
            execute: () => Promise.resolve({ outcome: "ok", result: { resumed: true } }),
          },
        ],
      ]),
    );
    const [action] = planDanglingIntents(foldRunState(events), tool);
    if (action === undefined) {
      throw new Error("Expected a resume action.");
    }

    const recorded = await applyDanglingIntentAction(
      {
        recorder,
        tool,
        clock,
        runId,
        signal: new AbortController().signal,
        ids: new SequentialIdGenerator(),
      },
      intent,
      action,
    );

    expect(recorded.map(({ type }) => type)).toEqual(["tool_result"]);
    expect(recorded[0]).toMatchObject({ callId, outcome: "ok" });
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0]?.call).toEqual({
      callId,
      toolId: "resume_tool",
      args: { value: 1 },
    });
  });

  it("does not execute a non-idempotent call until approval", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const { events, intent } = await createDanglingIntent(recorder, false);
    const tool = new FakeToolPort(
      new Map([
        [
          "resume_tool",
          {
            idempotent: false,
            timeoutMs: 1_000,
            execute: () => Promise.resolve({ outcome: "ok", result: { approved: true } }),
          },
        ],
      ]),
    );
    const [action] = planDanglingIntents(foldRunState(events), tool);
    if (action === undefined) {
      throw new Error("Expected a resume action.");
    }
    const options = {
      recorder,
      tool,
      clock,
      runId,
      signal: new AbortController().signal,
      ids: new SequentialIdGenerator(),
    };

    const approvalEvents = await applyDanglingIntentAction(options, intent, action);
    expect(approvalEvents.map(({ type }) => type)).toEqual([
      "approval_requested",
      "run_status_changed",
    ]);
    expect(approvalEvents[0]).toMatchObject({
      type: "approval_requested",
      callId,
      payload: { kind: "resume_ambiguity", callId, toolId: "resume_tool" },
    });
    expect(approvalEvents[1]).toMatchObject({ type: "run_status_changed", to: "suspended" });
    expect(tool.calls).toHaveLength(0);

    const request = approvalEvents[0];
    if (request?.type !== "approval_requested") {
      throw new Error("Expected an approval request.");
    }
    await recorder.withStepSpan(RUN_SPAN, {}, async () => {
      const recorded = await recorder.recordBatch([
        {
          type: "approval_resolved",
          v: 1,
          approvalId: request.approvalId,
          decision: "approve",
          waitMs: 0,
        },
        {
          type: "run_status_changed",
          v: 1,
          from: "suspended",
          to: "running",
          reason: "resumed",
        },
      ]);
      const last = recorded.at(-1);
      if (last === undefined) {
        throw new Error("Expected approval resolution events.");
      }
      return last;
    });

    const resultEvents = await executeApprovedDanglingIntent(options, intent);
    expect(resultEvents.map(({ type }) => type)).toEqual(["tool_result"]);
    expect(resultEvents[0]).toMatchObject({ callId, outcome: "ok" });
    expect(tool.calls).toHaveLength(1);
    const stored: Event[] = [];
    for await (const event of store.read(runId)) {
      stored.push(event);
    }
    expect(stored.filter(({ type }) => type === "tool_intent")).toHaveLength(1);
  });
});
