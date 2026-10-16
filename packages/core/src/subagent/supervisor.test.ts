// SPDX-License-Identifier: Apache-2.0
import { ensureTracingFallback } from "@harness/telemetry";
import { FakeClock, Id, JsonValue } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { describe, expect, it, vi } from "vitest";
import { RunRecorder } from "../recorder.js";
import type { IdGenerator, ModelToolCall, RunContext, ToolPort } from "../ports.js";
import { RUN_SPAN, TOOL_CALL_SPAN } from "../spans.js";
import { toolRunContext } from "../steps/prepare-tool.js";
import type { ResolvedRole } from "../roles.js";
import { RunScopeRegistry } from "./scope.js";
import { restrictToolPort, SubagentError, SubagentSupervisor } from "./supervisor.js";
import type {
  SubagentRunRequest,
  SubagentRunner,
  SubagentSupervisorOptions,
} from "./supervisor.js";

const parentRunId = Id.parse("00000000000000000000000000");
const parentCallId = Id.parse("11111111111111111111111111");
const childRunId = Id.parse("22222222222222222222222222");
const segmentId = Id.parse("33333333333333333333333333");
const hash = "a".repeat(64);

const role: ResolvedRole = {
  id: "worker",
  tools: ["fs.read", "fs.missing"],
  maxDepth: 2,
  maxChildren: 2,
};

function idGenerator(): IdGenerator {
  return { next: () => childRunId };
}

function parentTools(): ToolPort {
  return {
    describe: (toolId) =>
      toolId === "fs.read" ? { idempotent: true, timeoutMs: 1_000 } : undefined,
    getToolSpecs: () => [
      { toolId: "fs.read", description: "read", inputSchema: { type: "object" } },
      { toolId: "fs.write", description: "write", inputSchema: { type: "object" } },
    ],
    prepare: vi.fn((call) => Promise.resolve(call)),
    execute: vi.fn(() => Promise.resolve({ outcome: "ok" as const, result: null })),
  };
}

function context(overrides: Partial<RunContext> = {}, tools: ToolPort = parentTools()): RunContext {
  return {
    runId: parentRunId,
    signal: new AbortController().signal,
    toolRegistry: tools,
    depth: 0,
    recordSubagentSpawned: vi.fn(() => Promise.resolve()),
    recordSubagentCompleted: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function toolCall(): ModelToolCall {
  return { callId: parentCallId, toolId: "agent.spawn", args: {} };
}

function supervisorOptions(
  runChild: SubagentRunner,
  options: {
    readonly store?: InMemoryEventStore;
    readonly scopes?: RunScopeRegistry;
    readonly ids?: IdGenerator;
    readonly parentSpanContext?: () => { traceId: string; spanId: string; traceFlags: number };
    readonly tools?: ToolPort;
  } = {},
): SubagentSupervisorOptions {
  return {
    store: options.store ?? new InMemoryEventStore(),
    ids: options.ids ?? idGenerator(),
    scopes: options.scopes ?? new RunScopeRegistry(),
    parentTools: options.tools ?? parentTools(),
    runChild,
    ...(options.parentSpanContext === undefined
      ? {}
      : { parentSpanContext: options.parentSpanContext }),
  };
}

async function seedParent(store: InMemoryEventStore): Promise<void> {
  await store.append(
    parentRunId,
    [
      {
        runId: parentRunId,
        type: "run_created",
        v: 1,
        ts: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId,
        configHash: hash,
        policyVersion: "test",
        depth: 0,
      },
    ],
    0,
  );
}

function ensureTracing(): void {
  ensureTracingFallback(
    RUN_SPAN.start({
      "harness.run.id": parentRunId,
      "harness.segment.id": segmentId,
    }),
  );
}

describe("SubagentSupervisor", () => {
  it("records the parent announcement before starting a linked child run", async () => {
    ensureTracing();
    const store = new InMemoryEventStore();
    const clock = new FakeClock(1);
    const recorder = new RunRecorder(store, parentRunId, segmentId, 1, clock);
    const scopes = new RunScopeRegistry();
    const appendOrder: { readonly runId: string; readonly types: readonly string[] }[] = [];
    const append = store.append.bind(store);
    vi.spyOn(store, "append").mockImplementation((runId, events, expectedSeq) => {
      appendOrder.push({ runId, types: events.map(({ type }) => type) });
      return append(runId, events, expectedSeq);
    });
    let childRequest: SubagentRunRequest | undefined;
    const supervisor = new SubagentSupervisor(
      supervisorOptions(
        async (request) => {
          childRequest = request;
          const parentEvents = [];
          for await (const event of store.read(parentRunId)) {
            parentEvents.push(event);
          }
          expect(parentEvents.some(({ type }) => type === "subagent_spawned")).toBe(true);
          const childRecorder = new RunRecorder(store, childRunId, segmentId, 0, clock);
          await childRecorder.withStepSpan(
            RUN_SPAN,
            {
              "harness.run.parent_id": parentRunId,
              "harness.run.depth": request.depth,
            },
            () =>
              childRecorder
                .recordBatch([
                  {
                    type: "run_created",
                    v: 1,
                    configHash: hash,
                    policyVersion: "test",
                    parentRunId,
                    parentCallId,
                    scopeId: request.scopeId,
                    depth: request.depth,
                  },
                  { type: "run_input", v: 1, input: request.input, inputKind: "initial" },
                  {
                    type: "run_status_changed",
                    v: 1,
                    from: "pending",
                    to: "running",
                    reason: "start",
                  },
                ])
                .then((events) => {
                  const lastEvent = events.at(-1);
                  if (lastEvent === undefined) {
                    throw new Error("Expected child run events.");
                  }
                  return lastEvent;
                }),
            { links: request.rootSpanLinks, parentContext: request.rootSpanParent },
          );
          return {
            childRunId: request.runId,
            status: "completed",
            value: null,
            usage: { inputTokens: 2, outputTokens: 3, costMicros: 4 },
          };
        },
        {
          store,
          scopes,
          tools: parentTools(),
          parentSpanContext: () => ({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            traceFlags: 1,
          }),
        },
      ),
    );
    await seedParent(store);
    const toolContext = toolRunContext(context({ depth: 0 }), recorder, []);

    let childResult: JsonValue = null;
    await recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      await recorder.record({
        type: "tool_intent",
        v: 1,
        callId: parentCallId,
        toolId: "agent.spawn",
        idempotent: false,
        policyDecision: "allow",
        argsHash: hash,
        args: {},
      });
      childResult = JsonValue.parse(
        await supervisor.spawn({
          role,
          goal: "tokenized goal",
          inputs: { ref: "<EMAIL_1>" },
          call: toolCall(),
          context: toolContext,
        }),
      );
      return recorder.record({
        type: "tool_result",
        v: 1,
        callId: parentCallId,
        toolId: "agent.spawn",
        outcome: "ok",
        latencyMs: 0,
        result: childResult,
      });
    });

    expect(childResult).toEqual({
      childRunId,
      status: "completed",
      value: null,
      usage: { inputTokens: 2, outputTokens: 3, costMicros: 4 },
    });
    expect(childRequest).toMatchObject({
      runId: childRunId,
      parentRunId,
      parentCallId,
      scopeId: parentRunId,
      depth: 1,
      role,
      input: { goal: "tokenized goal", inputs: { ref: "<EMAIL_1>" } },
    });
    expect(childRequest?.rootSpanLinks[0]?.context).toEqual(childRequest?.parentSpanContext);
    expect(scopes.scopeOf(childRunId)).toBe(parentRunId);
    expect(childRequest?.tools.describe("fs.read")).toBeDefined();
    expect(childRequest?.tools.describe("fs.write")).toBeUndefined();
    const childEvents = [];
    for await (const event of store.read(childRunId)) {
      childEvents.push(event);
    }
    expect(childEvents[0]).toMatchObject({
      type: "run_created",
      parentRunId,
      parentCallId,
      depth: 1,
    });
    const spawnAppend = appendOrder.findIndex(({ types }) => types.includes("subagent_spawned"));
    const childAppend = appendOrder.findIndex(
      ({ runId: requestedRunId, types }) =>
        requestedRunId === childRunId && types.includes("run_created"),
    );
    expect(spawnAppend).toBeGreaterThanOrEqual(0);
    expect(childAppend).toBeGreaterThan(spawnAppend);
    expect(
      appendOrder.some(
        ({ runId: requestedRunId, types }) =>
          requestedRunId === parentRunId && types.includes("subagent_completed"),
      ),
    ).toBe(true);
  });

  it("enforces role depth and existing-child limits before recording", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    await store.append(
      parentRunId,
      [
        {
          runId: parentRunId,
          type: "subagent_spawned",
          v: 1,
          ts: 2,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId,
          childRunId,
          role: "worker",
          parentCallId: Id.parse("55555555555555555555555555"),
        },
      ],
      1,
    );
    const recordSpawned = vi.fn(() => Promise.resolve());
    const runChild = vi.fn(() =>
      Promise.resolve({
        childRunId,
        status: "completed" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
    const supervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );

    await expect(
      supervisor.spawn({
        role,
        goal: "goal",
        call: toolCall(),
        context: context({ depth: 2, recordSubagentSpawned: recordSpawned }),
      }),
    ).rejects.toMatchObject({ code: "subagent_depth_limit" });
    await expect(
      supervisor.spawn({
        role: { ...role, maxChildren: 1 },
        goal: "goal",
        call: toolCall(),
        context: context({ recordSubagentSpawned: recordSpawned }),
      }),
    ).rejects.toMatchObject({ code: "subagent_children_limit" });
    expect(recordSpawned).not.toHaveBeenCalled();
    expect(runChild).not.toHaveBeenCalled();
  });

  it("records aggregated usage when a child runner rejects, then rethrows", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const recordCompleted = vi.fn(() => Promise.resolve());
    const runChild: SubagentRunner = async (request) => {
      await store.append(
        request.runId,
        [
          {
            runId: request.runId,
            type: "run_created",
            v: 1,
            ts: 1,
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            segmentId,
            configHash: hash,
            policyVersion: "test",
            parentRunId,
            parentCallId,
            scopeId: parentRunId,
            depth: 1,
          },
          {
            runId: request.runId,
            type: "model_response",
            v: 1,
            ts: 2,
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            segmentId,
            requestId: parentCallId,
            provider: "test",
            model: "test",
            inputTokens: 3,
            outputTokens: 5,
            costMicros: 7,
            finishReason: "stop",
            latencyMs: 1,
            schemaValid: true,
            repairAttempts: 0,
            fallbackDepth: 0,
            content: [],
            providerBlobs: null,
          },
        ],
        0,
      );
      throw Object.assign(new Error("conflict"), { code: "seq_conflict" });
    };
    const supervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );

    await expect(
      supervisor.spawn({
        role,
        goal: "goal",
        call: toolCall(),
        context: context({ recordSubagentCompleted: recordCompleted }),
      }),
    ).rejects.toMatchObject({ code: "seq_conflict" });
    expect(recordCompleted).toHaveBeenCalledExactlyOnceWith({
      childRunId,
      outcome: "failed",
      inputTokens: 3,
      outputTokens: 5,
      costMicros: 7,
    });
  });

  it("reuses the durable child id and does not duplicate parent events after a fresh resume", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const clock = new FakeClock(1);
    const firstRecorder = new RunRecorder(store, parentRunId, segmentId, 1, clock);
    const runChild = vi.fn((request: SubagentRunRequest) =>
      Promise.resolve({
        childRunId: request.runId,
        status: "completed" as const,
        value: { text: "done" },
        usage: { inputTokens: 3, outputTokens: 5, costMicros: 7 },
      }),
    );
    const firstSupervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );

    const invokeSpawn = async (recorder: RunRecorder, supervisor: SubagentSupervisor) =>
      recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
        const result = await supervisor.spawn({
          role,
          goal: "goal",
          call: toolCall(),
          context: toolRunContext(context(), recorder, []),
        });
        return recorder.record({
          type: "tool_result",
          v: 1,
          callId: parentCallId,
          toolId: "agent.spawn",
          outcome: "ok",
          latencyMs: 0,
          result: JsonValue.parse(result),
        });
      });

    ensureTracing();
    await invokeSpawn(firstRecorder, firstSupervisor);
    const resumedRecorder = new RunRecorder(store, parentRunId, segmentId, 4, clock);
    const resumedSupervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        ids: { next: () => Id.parse("44444444444444444444444444") },
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );
    await invokeSpawn(resumedRecorder, resumedSupervisor);

    const events = [];
    for await (const event of store.read(parentRunId)) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "subagent_spawned")).toHaveLength(1);
    expect(events.filter((event) => event.type === "subagent_completed")).toHaveLength(1);
    expect(events.find((event) => event.type === "subagent_spawned")).toMatchObject({
      childRunId,
      parentCallId,
    });
    expect(runChild.mock.calls.map(([request]) => request.runId)).toEqual([childRunId, childRunId]);
  });

  it("preserves the original runner error if failed-completion recording also fails", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const runnerError = Object.assign(new Error("runner failed"), { code: "seq_conflict" });
    const supervisor = new SubagentSupervisor(
      supervisorOptions(() => Promise.reject(runnerError), {
        store,
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );

    await expect(
      supervisor.spawn({
        role,
        goal: "goal",
        call: toolCall(),
        context: context({
          recordSubagentCompleted: () => Promise.reject(new Error("recorder failed")),
        }),
      }),
    ).rejects.toBe(runnerError);
  });

  it("fails closed when durable recording or a parent span is unavailable", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const runChild = vi.fn(() =>
      Promise.resolve({
        childRunId,
        status: "completed" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
    const supervisor = new SubagentSupervisor(supervisorOptions(runChild, { store }));
    const withoutRecorder: RunContext = {
      runId: parentRunId,
      signal: new AbortController().signal,
    };

    await expect(
      supervisor.spawn({ role, goal: "goal", call: toolCall(), context: withoutRecorder }),
    ).rejects.toBeInstanceOf(SubagentError);
    await expect(
      supervisor.spawn({ role, goal: "goal", call: toolCall(), context: context() }),
    ).rejects.toMatchObject({ code: "subagent_parent_span_missing" });
    await expect(
      supervisor.spawn({
        role,
        goal: "goal",
        call: toolCall(),
        context: {
          runId: parentRunId,
          signal: new AbortController().signal,
          depth: 0,
          recordSubagentSpawned: vi.fn(() => Promise.resolve()),
        },
      }),
    ).rejects.toMatchObject({ code: "subagent_recorder_unavailable" });
    expect(runChild).not.toHaveBeenCalled();
  });

  it("restricts the child registry to existing role tools", async () => {
    const tools = parentTools();
    const restricted = restrictToolPort(tools, ["fs.read", "fs.write"]);

    expect(restricted.getToolSpecs?.().map(({ toolId }) => toolId)).toEqual(["fs.read"]);
    expect(restricted.describe("fs.read")).toBeDefined();
    expect(restricted.describe("fs.write")).toBeUndefined();
    await expect(
      restricted.execute({ ...toolCall(), toolId: "fs.write" }, context({}, tools)),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "unknown_tool" });
  });
});
