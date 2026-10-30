// SPDX-License-Identifier: Apache-2.0
import { context, trace } from "@opentelemetry/api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactionStep,
  createRuntime,
  RunRecorder,
  type ModelCompletion,
  type ModelToolCall,
  type PolicyPort,
  type RunLoopResult,
  type RuntimeConfig,
  type Runtime,
  type ToolPort,
} from "@rovinos/core";
import {
  CrashingEventStore,
  FakeModelPort,
  FakeToolPort,
  SimulatedCrash,
  type FakeToolDefinition,
} from "@rovinos/core/testing";
import { SummarizingStrategy } from "@rovinos/context";
import { InMemoryEventStore, type EventStore } from "@rovinos/store";
import {
  Code,
  FakeClock,
  Id,
  RunConfigSchema,
  SequentialIdGenerator,
  type Event,
  type JsonValue,
  type NewEvent,
} from "@rovinos/schemas";
import { createTestContextManager, createTestSpanCollector } from "@rovinos/telemetry/testing";
import type { ResolvedRun } from "@rovinos/replay";
import { ResolvedRunSchema } from "@rovinos/replay";

const config: RuntimeConfig = { run: RunConfigSchema.parse({}) };

const safeTool = Code.parse("synthetic.idempotent");
const editableTool = Code.parse("synthetic.editable");
const deniedTool = Code.parse("synthetic.denied");
const approvalId = Code.parse("cli.synthetic");

export interface GoldenScenario {
  readonly config: RuntimeConfig;
  readonly crashResumed: boolean;
  readonly model: FakeModelPort;
  readonly policy: PolicyPort;
  readonly resolved: ResolvedRun;
  readonly responses: readonly ModelCompletion[];
  readonly coverageEvents: readonly Event[];
}

interface AppendBoundary {
  readonly callIds: readonly string[];
  readonly eventTypes: readonly Event["type"][];
}

class TrackingEventStore extends InMemoryEventStore {
  readonly boundaries: AppendBoundary[] = [];

  override append(...args: Parameters<EventStore["append"]>) {
    this.track(args[1]);
    return super.append(...args);
  }

  override appendWithSnapshot(...args: Parameters<EventStore["appendWithSnapshot"]>) {
    this.track(args[1]);
    return super.appendWithSnapshot(...args);
  }

  override appendWithUsage(...args: Parameters<EventStore["appendWithUsage"]>) {
    this.track(args[1]);
    return super.appendWithUsage(...args);
  }

  private track(events: readonly NewEvent[]): void {
    this.boundaries.push({
      callIds: events.flatMap((event) =>
        "callId" in event && event.callId !== undefined ? [event.callId] : [],
      ),
      eventTypes: events.map(({ type }) => type),
    });
  }
}

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "synthetic",
    model: "script",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function call(callId: number, toolId: string, args: JsonValue): ModelToolCall {
  return {
    callId: Id.parse(String(callId).padStart(26, "0")),
    toolId: Code.parse(toolId),
    args,
  };
}

function createPolicy(): PolicyPort {
  return {
    version: Code.parse("synthetic.policy"),
    decide: ({ toolId }) => {
      if (toolId === editableTool) {
        return {
          decision: "ask",
          ruleId: Code.parse("synthetic.ask"),
          reason: Code.parse("approval_required"),
          editable: ["/value"],
        };
      }
      if (toolId === deniedTool) {
        return {
          decision: "deny",
          ruleId: Code.parse("synthetic.deny"),
          reason: Code.parse("policy_denied"),
          editable: [],
        };
      }
      return {
        decision: "allow",
        ruleId: Code.parse("synthetic.allow"),
        reason: Code.parse("policy_allowed"),
        editable: [],
      };
    },
  };
}

function createTool(): ToolPort {
  const definition = (
    idempotent: boolean,
  ): FakeToolDefinition => ({
    idempotent,
    timeoutMs: 1_000,
    execute: (toolCall) =>
      Promise.resolve({
        outcome: "ok",
        result: { tool: toolCall.toolId, value: toolCall.args },
      }),
  });
  return new FakeToolPort(
    new Map([
      [safeTool, definition(true)],
      [editableTool, definition(false)],
      [deniedTool, definition(true)],
    ]),
  );
}

function createResponses(reverseToolCalls: boolean): ModelCompletion[] {
  const safeCall = call(71, safeTool, { key: "synthetic" });
  const editableCall = call(72, editableTool, { value: "before" });
  return [
    completion([{ type: "tool_call", ...(reverseToolCalls ? editableCall : safeCall) }]),
    completion([{ type: "tool_call", ...(reverseToolCalls ? safeCall : editableCall) }]),
    completion([{ type: "tool_call", ...call(73, deniedTool, { value: "blocked" }) }]),
    completion([{ type: "text", text: "synthetic final answer" }]),
  ];
}

function isSimulatedCrash(error: unknown): error is SimulatedCrash {
  return error instanceof SimulatedCrash;
}

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function addSyntheticCompaction(runtime: Runtime, runId: string): Promise<void> {
  const events = await readEvents(runtime.store, runId);
  const lastEvent = events.at(-1);
  if (lastEvent === undefined) {
    throw new Error("Expected an event before context compaction.");
  }
  const recorder = new RunRecorder(
    runtime.store,
    Id.parse(runId),
    lastEvent.segmentId,
    events.length,
    runtime.clock,
  );
  await compactionStep({
    recorder,
    events,
    strategy: new SummarizingStrategy({ provider: "synthetic", model: "script" }),
    summarizer: {
      summarize: () =>
        Promise.resolve({
          text: "synthetic compacted summary",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
    },
    budget: { maxTokens: 1, reserveOutputTokens: 0 },
    counter: { count: () => 10 },
    goal: "synthetic golden scenario",
    sanitizeSummary: (summary) => Promise.resolve(summary),
    keepRecentGroups: 0,
  });
}

async function executeScenario(
  store: EventStore,
  reverseToolCalls: boolean,
  crashExpected: boolean,
  includeCompaction: boolean,
): Promise<GoldenScenario> {
  const responses = createResponses(reverseToolCalls);
  const model = new FakeModelPort(responses);
  const policy = createPolicy();
  const clock = new FakeClock(1_000);
  const ids = new SequentialIdGenerator();
  const dataDir = await mkdtemp(join(tmpdir(), "harness-golden-replay-"));
  const createRuntimeWithPorts = () =>
    createRuntime(config, {
      dataDir,
      store,
      clock,
      ids,
      model,
      policy,
      tool: createTool(),
      transientVault: true,
      sandboxBackend: {
        exec: () => Promise.reject(new Error("Unused synthetic sandbox backend.")),
      },
    });
  let runtime = await createRuntimeWithPorts();
  let runId: Id | undefined;
  let crashResumed = false;
  try {
    const started = runtime.start("synthetic golden scenario");
    runId = started.runId;
    const recoverCrash = async (
      operation: () => Promise<RunLoopResult>,
    ): Promise<RunLoopResult> => {
      try {
        return await operation();
      } catch (error) {
        if (!crashExpected || !isSimulatedCrash(error)) {
          throw error;
        }
        crashResumed = true;
        await runtime.close();
        runtime = await createRuntimeWithPorts();
        const resumed = await runtime.resume(started.runId);
        return resumed;
      }
    };
    let result = await recoverCrash(() => started.completion);
    while (result.status === "suspended") {
      const approval = result.state.pendingApprovals.values().next().value;
      if (approval === undefined) {
        throw new Error("Expected the scripted approval.");
      }
      await runtime.resolveApproval(started.runId, approval.approvalId, "edit", {
        edits: { value: "after-edit" },
        metadata: { decidedBy: "human", approverId: approvalId },
      });
      if (includeCompaction) {
        await addSyntheticCompaction(runtime, started.runId);
      }
      result = await recoverCrash(() => runtime.resume(started.runId));
    }
    if (runId === undefined) {
      throw new Error("Expected the scripted run identifier.");
    }
    const events = await readEvents(runtime.store, runId);
    return {
      config,
      crashResumed,
      model,
      policy,
      responses,
      coverageEvents: [],
      resolved: ResolvedRunSchema.parse({
        rootRunId: runId,
        runs: [{ runId, role: "root", events }],
      }),
    };
  } finally {
    try {
      await runtime.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

function crashBoundaryForEditableResult(store: TrackingEventStore): number {
  const index = store.boundaries.findIndex(
    ({ callIds, eventTypes }) =>
      eventTypes.includes("tool_result") && callIds.includes(call(72, editableTool, {}).callId),
  );
  if (index < 0) {
    throw new Error("Expected a recorded editable tool result.");
  }
  return index + 1;
}

export async function recordGoldenScenario(reverseToolCalls = false): Promise<GoldenScenario> {
  const referenceStore = new TrackingEventStore();
  await executeScenario(referenceStore, reverseToolCalls, false, false);
  const crashAt = crashBoundaryForEditableResult(referenceStore);
  const store = new CrashingEventStore(new InMemoryEventStore(), {
    crashAt,
    mode: "after_commit",
  });
  const replayable = await executeScenario(store, reverseToolCalls, true, false);
  const compacted = await executeScenario(new InMemoryEventStore(), reverseToolCalls, false, true);
  return {
    ...replayable,
    coverageEvents: compacted.resolved.runs[0]?.events ?? [],
  };
}

/** Provides isolated in-memory tracing for runtime and replay scenarios that write checkpoints. */
export async function withGoldenTracing<T>(run: () => Promise<T>): Promise<T> {
  trace.disable();
  context.disable();
  const spans = createTestSpanCollector();
  trace.setGlobalTracerProvider(spans.provider);
  context.setGlobalContextManager(createTestContextManager());
  try {
    return await run();
  } finally {
    await spans.provider.shutdown();
    trace.disable();
    context.disable();
  }
}
