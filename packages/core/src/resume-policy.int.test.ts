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
import {
  FakeClock,
  SequentialIdGenerator,
  UNREGISTERED_TOOL_ID,
  type Event,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foldRunState, type ToolIntentEvent } from "./run-state.js";
import { RunRecorder } from "./recorder.js";
import type { ToolPort } from "./ports.js";
import { planDanglingIntents } from "./resume-policy.js";
import {
  applyDanglingIntents,
  resolveDanglingIntentApproval,
  ResumeActionMismatchError,
} from "./steps/resume-tool-step.js";
import { FakeToolPort } from "./testing/index.js";
import { RUN_SPAN } from "./spans.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const callId = "22222222222222222222222222";
const secondCallId = "33333333333333333333333333";
const thirdCallId = "44444444444444444444444444";
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

async function createMultipleDanglingIntents(recorder: RunRecorder): Promise<Event[]> {
  let events: Event[] = [];
  await recorder.withStepSpan(RUN_SPAN, {}, async () => {
    events = await recorder.recordBatch([
      { type: "run_created", v: 1, configHash, policyVersion: "test.policy" },
      { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
      {
        type: "tool_intent",
        v: 1,
        callId,
        toolId: "idempotent_tool",
        idempotent: true,
        policyDecision: "allow",
        argsHash: "d".repeat(64),
        args: { value: 1 },
      },
      {
        type: "tool_intent",
        v: 1,
        callId: secondCallId,
        toolId: "non_idempotent_tool_1",
        idempotent: false,
        policyDecision: "allow",
        argsHash: "e".repeat(64),
        args: { value: 2 },
      },
      {
        type: "tool_intent",
        v: 1,
        callId: thirdCallId,
        toolId: "non_idempotent_tool_2",
        idempotent: false,
        policyDecision: "allow",
        argsHash: "f".repeat(64),
        args: { value: 3 },
      },
    ]);
    const last = events.at(-1);
    if (last === undefined) {
      throw new Error("Expected dangling intent events.");
    }
    return last;
  });
  return events;
}

describe("dangling tool intent resume", () => {
  it("records a missing tool with the unregistered sentinel", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const { events } = await createDanglingIntent(recorder, true);
    const tool = new FakeToolPort();
    const [action] = planDanglingIntents(foldRunState(events), tool);
    if (action === undefined) {
      throw new Error("Expected a resume action.");
    }

    const recorded = await applyDanglingIntents(
      {
        recorder,
        tool,
        clock,
        runId,
        signal: new AbortController().signal,
        ids: new SequentialIdGenerator(),
      },
      foldRunState(events),
      [action],
    );

    expect(recorded).toMatchObject([
      {
        type: "tool_result",
        toolId: UNREGISTERED_TOOL_ID,
        outcome: "error",
        errorCode: "unknown_tool",
      },
    ]);
    expect(tool.calls).toHaveLength(0);
  });

  it("re-runs idempotent calls once with the original callId and no new intent", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const { events } = await createDanglingIntent(recorder, true);
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

    const state = foldRunState(events);
    const recorded = await applyDanglingIntents(
      {
        recorder,
        tool,
        clock,
        runId,
        signal: new AbortController().signal,
        ids: new SequentialIdGenerator(),
      },
      state,
      [action],
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

  describe("tool resume strategy", () => {
    it("records recovered child completion before its tool result", async () => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
      const { events } = await createDanglingIntent(recorder, false);
      const tool: ToolPort = {
        describe: () => ({ idempotent: false, timeoutMs: 1_000 }),
        execute: () => Promise.resolve({ outcome: "ok", result: null }),
        resumeStrategy: () => ({
          onDanglingIntent: () =>
            Promise.resolve({
              kind: "result",
              execution: {
                outcome: "ok",
                result: { childRunId: "55555555555555555555555555", status: "completed" },
              },
              completion: {
                childRunId: "55555555555555555555555555",
                outcome: "completed",
                inputTokens: 2,
                outputTokens: 3,
                steps: 1,
              },
            }),
        }),
      };
      const state = foldRunState(events);
      await applyDanglingIntents(
        { recorder, tool, clock, runId, signal: new AbortController().signal, ids: new SequentialIdGenerator() },
        state,
        planDanglingIntents(state, tool),
      );

      const stored: Event[] = [];
      for await (const event of store.read(runId)) {
        stored.push(event);
      }
      expect(stored.slice(-2).map(({ type }) => type)).toEqual([
        "subagent_completed",
        "tool_result",
      ]);
    });

    it("suspends instead of recording a tool result while the child awaits approval", async () => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
      const { events } = await createDanglingIntent(recorder, false);
      const tool: ToolPort = {
        describe: () => ({ idempotent: false, timeoutMs: 1_000 }),
        execute: () => Promise.resolve({ outcome: "ok", result: null }),
        resumeStrategy: () => ({
          onDanglingIntent: () => Promise.resolve({ kind: "suspend" }),
        }),
      };
      const state = foldRunState(events);
      await applyDanglingIntents(
        { recorder, tool, clock, runId, signal: new AbortController().signal, ids: new SequentialIdGenerator() },
        state,
        planDanglingIntents(state, tool),
      );

      const stored: Event[] = [];
      for await (const event of store.read(runId)) {
        stored.push(event);
      }
      expect(stored.at(-1)).toMatchObject({
        type: "run_status_changed",
        to: "suspended",
        reason: "awaiting_subagent",
      });
      expect(stored.some((event) => event.type === "tool_result")).toBe(false);
    });
  });

  it("executes a non-idempotent dangling call once after resume-ambiguity approval", async () => {
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

    const approvalEvents = await applyDanglingIntents(options, foldRunState(events), [action]);
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
    let resolutionEvents: Event[] = [];
    await recorder.withStepSpan(RUN_SPAN, {}, async () => {
      resolutionEvents = await recorder.recordBatch([
        {
          type: "approval_resolved",
          v: 1,
          approvalId: request.approvalId,
          decision: "approve",
          decidedBy: "human",
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
      const last = resolutionEvents.at(-1);
      if (last === undefined) {
        throw new Error("Expected approval resolution events.");
      }
      return last;
    });
    const resolution = resolutionEvents.find(
      (event): event is Extract<Event, { type: "approval_resolved" }> =>
        event.type === "approval_resolved",
    );
    if (resolution === undefined) {
      throw new Error("Expected approval resolution event.");
    }

    const resultEvents = await resolveDanglingIntentApproval(options, intent, request, resolution);
    expect(resultEvents.map(({ type }) => type)).toEqual([
      "tool_execution_started",
      "tool_result",
    ]);
    expect(resultEvents[1]).toMatchObject({ callId, outcome: "ok" });
    expect(tool.calls).toHaveLength(1);
    const stored: Event[] = [];
    for await (const event of store.read(runId)) {
      stored.push(event);
    }
    expect(stored.filter(({ type }) => type === "tool_intent")).toHaveLength(1);
  });

  it("escalates a direct rerun when the durable intent declared it non-idempotent", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const { events } = await createDanglingIntent(recorder, false);
    const tool = new FakeToolPort(
      new Map([
        [
          "resume_tool",
          {
            idempotent: true,
            timeoutMs: 1_000,
            execute: () => Promise.resolve({ outcome: "ok", result: null }),
          },
        ],
      ]),
    );
    const state = foldRunState(events);
    const recorded = await applyDanglingIntents(
      {
        recorder,
        tool,
        clock,
        runId,
        signal: new AbortController().signal,
        ids: new SequentialIdGenerator(),
      },
      state,
      [{ kind: "rerun", callId }],
    );

    expect(recorded.map(({ type }) => type)).toEqual(["approval_requested", "run_status_changed"]);
    expect(tool.calls).toHaveLength(0);
  });

  it("batches several escalations into one suspension while rerunning idempotent calls", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const events = await createMultipleDanglingIntents(recorder);
    const tool = new FakeToolPort(
      new Map(
        [
          { toolId: "idempotent_tool", idempotent: true },
          { toolId: "non_idempotent_tool_1", idempotent: false },
          { toolId: "non_idempotent_tool_2", idempotent: false },
        ].map(
          ({ toolId, idempotent }) =>
            [
              toolId,
              {
                idempotent,
                timeoutMs: 1_000,
                execute: () => Promise.resolve({ outcome: "ok", result: null }),
              },
            ] as const,
        ),
      ),
    );
    const state = foldRunState(events);
    const actions = planDanglingIntents(state, tool);
    await applyDanglingIntents(
      {
        recorder,
        tool,
        clock,
        runId,
        signal: new AbortController().signal,
        ids: new SequentialIdGenerator(),
      },
      state,
      actions,
    );

    const stored: Event[] = [];
    for await (const event of store.read(runId)) {
      stored.push(event);
    }
    const folded = foldRunState(stored);
    expect(folded.status).toBe("suspended");
    expect(folded.pendingToolCalls.size).toBe(2);
    expect(stored.filter((event) => event.type === "approval_requested")).toHaveLength(2);
    expect(
      stored.filter((event) => event.type === "run_status_changed" && event.to === "suspended"),
    ).toHaveLength(1);
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0]?.call.callId).toBe(callId);
  });

  it("records a denied approval as one error result without executing the tool", async () => {
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
            execute: () => Promise.resolve({ outcome: "ok", result: null }),
          },
        ],
      ]),
    );
    const options = {
      recorder,
      tool,
      clock,
      runId,
      signal: new AbortController().signal,
      ids: new SequentialIdGenerator(),
    };
    const [requestEvent] = await applyDanglingIntents(options, foldRunState(events), [
      { kind: "escalate", callId },
    ]);
    if (requestEvent?.type !== "approval_requested") {
      throw new Error("Expected an approval request.");
    }
    let resolutionEvents: Event[] = [];
    await recorder.withStepSpan(RUN_SPAN, {}, async () => {
      resolutionEvents = await recorder.recordBatch([
        {
          type: "approval_resolved",
          v: 1,
          approvalId: requestEvent.approvalId,
          decision: "deny",
          decidedBy: "human",
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
      const last = resolutionEvents.at(-1);
      if (last === undefined) {
        throw new Error("Expected approval resolution events.");
      }
      return last;
    });
    const resolution = resolutionEvents.find(
      (event): event is Extract<Event, { type: "approval_resolved" }> =>
        event.type === "approval_resolved",
    );
    if (resolution === undefined) {
      throw new Error("Expected approval resolution event.");
    }
    await expect(
      resolveDanglingIntentApproval(
        options,
        intent,
        { ...requestEvent, callId: thirdCallId },
        resolution,
      ),
    ).rejects.toBeInstanceOf(ResumeActionMismatchError);
    await expect(
      resolveDanglingIntentApproval(options, intent, requestEvent, {
        ...resolution,
        approvalId: thirdCallId,
      }),
    ).rejects.toBeInstanceOf(ResumeActionMismatchError);

    const result = await resolveDanglingIntentApproval(options, intent, requestEvent, resolution);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "tool_result",
      outcome: "error",
      errorCode: "resume_ambiguous",
    });
    expect(tool.calls).toHaveLength(0);

    const stored: Event[] = [];
    for await (const event of store.read(runId)) {
      stored.push(event);
    }
    expect(foldRunState(stored).pendingToolCalls.size).toBe(0);
    expect(stored.filter((event) => event.type === "tool_result")).toHaveLength(1);
  });
});
