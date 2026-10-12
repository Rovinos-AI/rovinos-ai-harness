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
import { Code, FakeClock, SequentialIdGenerator, type Event } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RunRecorder, type EventPartial } from "../recorder.js";
import { Checkpointer } from "../checkpoint.js";
import { NaiveContext } from "../context/naive-context.js";
import { planDanglingIntents } from "../resume-policy.js";
import { foldRunState, type ApprovalRequestedEvent, type ToolIntentEvent } from "../run-state.js";
import { RUN_SPAN } from "../spans.js";
import { FakeToolPort, type FakeToolDefinition } from "../testing/index.js";
import type { PolicyPort, ToolPort } from "../ports.js";
import { applyDanglingIntents, resolveDanglingIntentApproval, toolStep } from "./tool-step.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const callIds = {
  idempotent: "22222222222222222222222222",
  stale: "33333333333333333333333333",
  nonIdempotent: "44444444444444444444444444",
  unknown: "55555555555555555555555555",
} as const;
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

class EmptyBatchRecorder extends RunRecorder {
  override recordBatch(_partials: readonly EventPartial[]): Promise<Event[]> {
    return Promise.resolve([]);
  }
}

beforeAll(() => {
  context.setGlobalContextManager(new TestContextManager());
  trace.setGlobalTracerProvider(new TestTracerProvider());
});

afterAll(() => {
  context.disable();
});

function createRecorder(): { readonly recorder: RunRecorder; readonly store: InMemoryEventStore } {
  const store = new InMemoryEventStore();
  return {
    store,
    recorder: new RunRecorder(store, runId, segmentId, 0, new FakeClock(100)),
  };
}

const allowPolicy: PolicyPort = {
  version: Code.parse("test.policy"),
  decide: async () => ({
    decision: "allow",
    ruleId: "test_allow",
    reason: "test_allowed",
    editable: [],
  }),
};

function toolStepDependencies(
  recorder: RunRecorder,
  tool: ToolPort,
  history: readonly Event[],
  policy: PolicyPort = allowPolicy,
) {
  const clock = new FakeClock(100);
  const ids = new SequentialIdGenerator();
  return {
    policy,
    ids,
    checkpointer: new Checkpointer({
      recorder,
      runId,
      context: new NaiveContext(),
      ids,
      clock,
    }),
    history,
    clock,
    runId,
    recorder,
    signal: new AbortController().signal,
    tool,
  };
}

async function createRun(
  recorder: RunRecorder,
  intents: readonly {
    readonly callId: ToolIntentEvent["callId"];
    readonly toolId: string;
    readonly idempotent: boolean;
  }[],
): Promise<Event[]> {
  let events: Event[] = [];
  await recorder.withStepSpan(RUN_SPAN, {}, async () => {
    events = await recorder.recordBatch([
      { type: "run_created", v: 1, configHash, policyVersion: "test.policy" },
      { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
      ...intents.map((intent) => ({
        type: "tool_intent" as const,
        v: 1 as const,
        ...intent,
        policyDecision: "allow" as const,
        argsHash: "d".repeat(64),
        args: { value: [1, null, { nested: true }] },
      })),
    ]);
    const last = events.at(-1);
    if (last === undefined) {
      throw new Error("Expected run events.");
    }
    return last;
  });
  return events;
}

function resumeOptions(
  recorder: RunRecorder,
  tool: FakeToolPort,
): {
  readonly recorder: RunRecorder;
  readonly tool: FakeToolPort;
  readonly clock: FakeClock;
  readonly runId: typeof runId;
  readonly signal: AbortSignal;
  readonly ids: SequentialIdGenerator;
} {
  return {
    recorder,
    tool,
    clock: new FakeClock(100),
    runId,
    signal: new AbortController().signal,
    ids: new SequentialIdGenerator(),
  };
}

describe("tool-step resume handling", () => {
  it("prepares direct tool calls inside their tool-call span without an ambient span", async () => {
    const { recorder } = createRecorder();
    const history = await createRun(recorder, []);
    const tool: ToolPort = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      prepare: async (call, runContext) => {
        await runContext.recordPiiAction?.({
          boundary: "tool_input",
          action: "tokenize",
          entities: [{ type: "email", count: 1 }],
        });
        return { ...call, args: "<EMAIL_1>" };
      },
      execute: () => Promise.resolve({ outcome: "ok", result: null }),
    };

    const events = await toolStep({
      ...toolStepDependencies(recorder, tool, history),
      calls: [{ callId: callIds.idempotent, toolId: "prepared", args: "synthetic@example.test" }],
    });

    expect(events.map(({ type }) => type)).toEqual(["pii_action", "tool_intent", "tool_result"]);
    expect(new Set(events.map(({ spanId }) => spanId)).size).toBe(1);
  });

  it("does not record in-flight or late PII summaries after a tool timeout result", async () => {
    const { recorder, store } = createRecorder();
    const history = await createRun(recorder, []);
    const append = store.append.bind(store);
    vi.spyOn(store, "append").mockImplementation(async (appendRunId, events, expectedSeq) => {
      if (events.some(({ type }) => type === "pii_action")) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return append(appendRunId, events, expectedSeq);
    });
    const tool: ToolPort = {
      describe: () => ({ idempotent: true, timeoutMs: 10 }),
      execute: async (_call, runContext) => {
        const summary = runContext.recordPiiAction?.({
          boundary: "tool_output",
          action: "tokenize",
          entities: [{ type: "email", count: 1 }],
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        await runContext.recordPiiAction?.({
          boundary: "tool_output",
          action: "tokenize",
          entities: [{ type: "email", count: 1 }],
        });
        await summary;
        return { outcome: "ok", result: null };
      },
    };

    const events = await toolStep({
      ...toolStepDependencies(recorder, tool, history),
      calls: [{ callId: callIds.idempotent, toolId: "late", args: null }],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const stored: Event[] = [];
    for await (const event of store.read(runId)) {
      stored.push(event);
    }
    const resultIndex = stored.findIndex(
      (event) => event.type === "tool_result" && event.callId === callIds.idempotent,
    );
    expect(events).toMatchObject([
      { type: "tool_intent" },
      { type: "pii_action" },
      { type: "tool_result", outcome: "timeout" },
    ]);
    expect(stored.findIndex((event) => event.type === "pii_action")).toBeLessThan(resultIndex);
    expect(stored.slice(resultIndex + 1).some((event) => event.type === "pii_action")).toBe(false);
  });

  it("records known and unknown calls around execution", async () => {
    const { recorder, store } = createRecorder();
    const history = await createRun(recorder, []);
    const tool = new FakeToolPort(
      new Map([
        [
          "known_tool",
          {
            idempotent: true,
            timeoutMs: 1_000,
            execute: () => Promise.resolve({ outcome: "ok", result: { done: true } }),
          },
        ],
        [
          "broken_tool",
          {
            idempotent: false,
            timeoutMs: 1_000,
            execute: () => Promise.reject(new Error("synthetic failure")),
          },
        ],
      ]),
    );

    const events = await toolStep({
      ...toolStepDependencies(recorder, tool, history),
      calls: [
        {
          callId: callIds.idempotent,
          toolId: "known_tool",
          args: { nested: [1, null, { value: true }] },
        },
        { callId: callIds.unknown, toolId: "missing_tool", args: null },
        { callId: "66666666666666666666666666", toolId: "broken_tool", args: null },
      ],
    });

    expect(events.map(({ type }) => type)).toEqual([
      "tool_intent",
      "tool_result",
      "tool_intent",
      "tool_result",
      "tool_intent",
      "tool_result",
    ]);
    expect(events[1]).toMatchObject({ outcome: "ok" });
    expect(events[3]).toMatchObject({ outcome: "denied", errorCode: "unknown_tool" });
    expect(events[5]).toMatchObject({ outcome: "error", errorCode: "tool_failed" });
    expect(tool.calls).toHaveLength(2);
    const stored: Event[] = [];
    for await (const event of store.read(runId)) {
      stored.push(event);
    }
    expect(foldRunState(stored).pendingToolCalls.size).toBe(0);
  });

  it("records policy denials before a result and never executes the tool", async () => {
    const { recorder } = createRecorder();
    const history = await createRun(recorder, []);
    const tool = new FakeToolPort(
      new Map([
        [
          "restricted",
          {
            idempotent: false,
            timeoutMs: 1_000,
            execute: () => Promise.resolve({ outcome: "ok", result: null }),
          },
        ],
      ]),
    );
    const policy: PolicyPort = {
      version: Code.parse("test.policy"),
      decide: async () => ({
        decision: "deny",
        ruleId: "deny_rule",
        reason: "forbidden",
        editable: [],
      }),
    };

    const events = await toolStep({
      ...toolStepDependencies(recorder, tool, history, policy),
      calls: [{ callId: callIds.nonIdempotent, toolId: "restricted", args: { path: "<PATH_1>" } }],
    });

    expect(events).toMatchObject([
      { type: "tool_intent", policyDecision: "deny", ruleId: "deny_rule" },
      { type: "tool_result", outcome: "denied", errorCode: "forbidden" },
    ]);
    expect(tool.calls).toHaveLength(0);
  });

  it("fails closed when policy evaluation throws", async () => {
    const { recorder } = createRecorder();
    const history = await createRun(recorder, []);
    const tool = new FakeToolPort(
      new Map([
        [
          "restricted",
          {
            idempotent: false,
            timeoutMs: 1_000,
            execute: () => Promise.resolve({ outcome: "ok", result: null }),
          },
        ],
      ]),
    );
    const policy: PolicyPort = {
      version: Code.parse("test.policy"),
      decide: () => Promise.reject(new Error("synthetic policy failure")),
    };

    const events = await toolStep({
      ...toolStepDependencies(recorder, tool, history, policy),
      calls: [{ callId: callIds.nonIdempotent, toolId: "restricted", args: null }],
    });

    expect(events).toMatchObject([
      { type: "tool_intent", policyDecision: "deny", ruleId: "default" },
      { type: "tool_result", outcome: "denied", errorCode: "policy_error" },
    ]);
    expect(tool.calls).toHaveLength(0);
  });

  it("persists an ask decision and suspends without executing", async () => {
    const { recorder } = createRecorder();
    const history = await createRun(recorder, []);
    const tool = new FakeToolPort(
      new Map([
        [
          "reviewed",
          {
            idempotent: false,
            timeoutMs: 1_000,
            execute: () => Promise.resolve({ outcome: "ok", result: null }),
          },
        ],
      ]),
    );
    const policy: PolicyPort = {
      version: Code.parse("test.policy"),
      decide: async () => ({
        decision: "ask",
        ruleId: "review_rule",
        reason: "human_review",
        editable: ["/path"],
      }),
    };

    const events = await toolStep({
      ...toolStepDependencies(recorder, tool, history, policy),
      calls: [
        { callId: callIds.nonIdempotent, toolId: "reviewed", args: { path: "<PATH_1>" } },
      ],
    });
    const state = foldRunState([...history, ...events]);

    expect(events.map(({ type }) => type)).toEqual([
      "tool_intent",
      "approval_requested",
      "run_status_changed",
      "checkpoint_written",
    ]);
    expect(events.slice(0, 3)).toMatchObject([
      { type: "tool_intent", policyDecision: "ask", ruleId: "review_rule" },
      {
        type: "approval_requested",
        payload: {
          kind: "tool_call",
          args: { path: "<PATH_1>" },
          ruleId: "review_rule",
          reason: "human_review",
          editableFields: ["/path"],
        },
      },
      { type: "run_status_changed", to: "suspended", reason: "awaiting_approval" },
    ]);
    expect(state.status).toBe("suspended");
    expect(state.pendingApprovals.size).toBe(1);
    expect(tool.calls).toHaveLength(0);
  });

  it("reruns only durable/current idempotent calls and batches escalations", async () => {
    const { recorder, store } = createRecorder();
    const events = await createRun(recorder, [
      { callId: callIds.idempotent, toolId: "idempotent", idempotent: true },
      { callId: callIds.stale, toolId: "stale", idempotent: false },
      { callId: callIds.nonIdempotent, toolId: "non-idempotent", idempotent: false },
      { callId: callIds.unknown, toolId: "unknown", idempotent: false },
    ]);
    const definitions = new Map<string, FakeToolDefinition>();
    for (const toolId of ["idempotent", "stale"]) {
      definitions.set(toolId, {
        idempotent: true,
        timeoutMs: 1_000,
        execute: () => Promise.resolve({ outcome: "ok", result: null }),
      });
    }
    definitions.set("non-idempotent", {
      idempotent: false,
      timeoutMs: 1_000,
      execute: () => Promise.resolve({ outcome: "ok", result: null }),
    });
    const tool = new FakeToolPort(definitions);
    const state = foldRunState(events);
    const actions = planDanglingIntents(state, tool);
    const resumed = await applyDanglingIntents(resumeOptions(recorder, tool), state, actions);
    const stored: Event[] = [];
    for await (const event of store.read(runId)) {
      stored.push(event);
    }

    expect(resumed.map(({ type }) => type)).toEqual([
      "tool_result",
      "tool_result",
      "approval_requested",
      "approval_requested",
      "run_status_changed",
    ]);
    expect(foldRunState(stored).status).toBe("suspended");
    expect(foldRunState(stored).pendingToolCalls.size).toBe(2);
    expect(
      stored.filter((event) => event.type === "run_status_changed" && event.to === "suspended"),
    ).toHaveLength(1);
    expect(tool.calls.map(({ call }) => call.callId)).toEqual([callIds.idempotent]);
  });

  it("records fail actions and rejects actions for absent intents", async () => {
    const { recorder } = createRecorder();
    const events = await createRun(recorder, [
      { callId: callIds.nonIdempotent, toolId: "non-idempotent", idempotent: false },
    ]);
    const tool = new FakeToolPort(new Map());
    const state = foldRunState(events);

    const failed = await applyDanglingIntents(resumeOptions(recorder, tool), state, [
      { kind: "fail", callId: callIds.nonIdempotent, errorCode: "resume_ambiguous" },
    ]);
    expect(failed[0]).toMatchObject({ outcome: "error", errorCode: "resume_ambiguous" });
    await expect(
      applyDanglingIntents(resumeOptions(recorder, tool), state, [
        { kind: "rerun", callId: callIds.unknown },
      ]),
    ).rejects.toMatchObject({ code: "resume_action_mismatch" });
  });

  it("fails safely if an escalation batch records no events", async () => {
    const store = new InMemoryEventStore();
    const recorder = new RunRecorder(store, runId, segmentId, 0, new FakeClock(100));
    const events = await createRun(recorder, [
      { callId: callIds.nonIdempotent, toolId: "non-idempotent", idempotent: false },
    ]);
    const state = foldRunState(events);
    const emptyRecorder = new EmptyBatchRecorder(store, runId, segmentId, 2, new FakeClock(100));
    const tool = new FakeToolPort(new Map());

    await expect(
      applyDanglingIntents(resumeOptions(emptyRecorder, tool), state, [
        { kind: "escalate", callId: callIds.nonIdempotent },
      ]),
    ).rejects.toMatchObject({ code: "resume_event_missing" });
  });

  it.each(["approve", "deny"] as const)(
    "applies the %s resolution without a second intent",
    async (decision) => {
      const { recorder, store } = createRecorder();
      const intentId = decision === "approve" ? callIds.stale : callIds.nonIdempotent;
      const { events } = await createDanglingIntentForResolution(recorder, intentId);
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
      const state = foldRunState(events);
      const [request] = await applyDanglingIntents(resumeOptions(recorder, tool), state, [
        { kind: "escalate", callId: intentId },
      ]);
      if (request?.type !== "approval_requested") {
        throw new Error("Expected an approval request.");
      }
      const resolution = await resolveEvent(recorder, request.approvalId, decision);
      const intent = state.pendingToolCalls.get(intentId);
      if (intent === undefined) {
        throw new Error("Expected a dangling tool intent.");
      }

      const result = await resolveDanglingIntentApproval(
        resumeOptions(recorder, tool),
        intent,
        request,
        resolution,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: "tool_result",
        outcome: decision === "approve" ? "ok" : "error",
        ...(decision === "deny" ? { errorCode: "resume_ambiguous" } : {}),
      });
      expect(tool.calls).toHaveLength(decision === "approve" ? 1 : 0);
      const stored: Event[] = [];
      for await (const event of store.read(runId)) {
        stored.push(event);
      }
      expect(stored.filter((event) => event.type === "tool_intent")).toHaveLength(1);
    },
  );
});

async function createDanglingIntentForResolution(
  recorder: RunRecorder,
  id: ToolIntentEvent["callId"],
): Promise<{ readonly events: Event[] }> {
  return {
    events: await createRun(recorder, [{ callId: id, toolId: "resume_tool", idempotent: false }]),
  };
}

async function resolveEvent(
  recorder: RunRecorder,
  approvalId: ApprovalRequestedEvent["approvalId"],
  decision: "approve" | "deny",
): Promise<Extract<Event, { type: "approval_resolved" }>> {
  let resolved: Extract<Event, { type: "approval_resolved" }> | undefined;
  await recorder.withStepSpan(RUN_SPAN, {}, async () => {
    const events = await recorder.recordBatch([
      { type: "approval_resolved", v: 1, approvalId, decision, waitMs: 0 },
      {
        type: "run_status_changed",
        v: 1,
        from: "suspended",
        to: "running",
        reason: "resumed",
      },
    ]);
    const event = events.find(
      (candidate): candidate is Extract<Event, { type: "approval_resolved" }> =>
        candidate.type === "approval_resolved",
    );
    if (event === undefined) {
      throw new Error("Expected an approval resolution.");
    }
    resolved = event;
    const last = events.at(-1);
    if (last === undefined) {
      throw new Error("Expected resolution events.");
    }
    return last;
  });
  if (resolved === undefined) {
    throw new Error("Expected an approval resolution.");
  }
  return resolved;
}
