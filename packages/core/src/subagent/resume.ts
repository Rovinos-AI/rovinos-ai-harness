// SPDX-License-Identifier: Apache-2.0
import {
  JsonValue as JsonValueSchema,
  type Event,
  type Id,
} from "@harness/schemas";
import type { EventStore } from "@harness/store";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import type { ModelToolCall, ToolPort } from "../ports.js";
import type { ToolResumeContext, ToolResumeDecision } from "../resume-policy.js";
import { foldRunState, type RunState } from "../run-state.js";
import type { ResolvedRole } from "../roles.js";
import type { RunScopeRegistry } from "./scope.js";
import {
  aggregateSubagentUsage,
  finalizeChild,
  type SubagentResult,
} from "./result.js";
import type { SubagentRunRequest, SubagentRunner } from "./supervisor.js";

type SpawnedEvent = Extract<Event, { type: "subagent_spawned" }>;
type RunCreatedEvent = Extract<Event, { type: "run_created" }>;

interface RecoverSubagentOptions {
  readonly store: EventStore;
  readonly scopes: RunScopeRegistry;
  readonly childTools: ToolPort;
  readonly role: ResolvedRole;
  readonly call: ModelToolCall;
  readonly state: RunState;
  readonly context: ToolResumeContext;
  readonly runChild: SubagentRunner;
}

interface ExistingChild {
  readonly spawned: SpawnedEvent;
  readonly childEvents: readonly Event[];
  readonly created: RunCreatedEvent;
  readonly completed: boolean;
}

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

function resultDecision(
  result: SubagentResult,
  events: readonly Event[],
  alreadyCompleted: boolean,
): ToolResumeDecision {
  if (result.status === "suspended") {
    return { kind: "suspend" };
  }
  const execution =
    result.status === "failed" || result.status === "cancelled"
      ? {
          outcome: "error" as const,
          errorCode: result.errorCode ?? "subagent_failed",
          result: { childRunId: result.childRunId, status: result.status },
        }
      : { outcome: "ok" as const, result: JsonValueSchema.parse(result) };
  const usage = aggregateSubagentUsage(events);
  return {
    kind: "result",
    execution,
    ...(!alreadyCompleted
      ? {
          completion: {
            childRunId: result.childRunId,
            outcome: result.status,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            steps: usage.steps,
            ...(usage.costMicros === undefined ? {} : { costMicros: usage.costMicros }),
          },
        }
      : {}),
  };
}

function missingChild(childRunId?: Id): ToolResumeDecision {
  return {
    kind: "result",
    execution: { outcome: "error", errorCode: "subagent_missing", result: null },
    ...(childRunId === undefined
      ? {}
      : {
          completion: {
            childRunId,
            outcome: "failed" as const,
            inputTokens: 0,
            outputTokens: 0,
            steps: 0,
          },
        }),
  };
}

/** Reconciles the durable child associated with one dangling `agent.spawn` intent. */
export async function recoverSubagentSpawn(
  options: RecoverSubagentOptions,
): Promise<ToolResumeDecision> {
  if (!options.state.pendingToolCalls.has(options.call.callId)) {
    return missingChild();
  }
  const parentEvents = await readEvents(options.store, options.context.runId);
  const spawned = parentEvents.find(
    (event) => event.type === "subagent_spawned" && event.parentCallId === options.call.callId,
  );
  if (spawned?.type !== "subagent_spawned") {
    return { kind: "rerun" };
  }
  const existing = await loadExistingChild(options, spawned, parentEvents);
  if ("decision" in existing) {
    return existing.decision;
  }
  return continueExistingChild(options, existing);
}

async function loadExistingChild(
  options: RecoverSubagentOptions,
  spawned: SpawnedEvent,
  parentEvents: readonly Event[],
): Promise<ExistingChild | { readonly decision: ToolResumeDecision }> {
  if (spawned.role !== options.role.id) {
    return { decision: missingChild(spawned.childRunId) };
  }
  const childEvents = await readEvents(options.store, spawned.childRunId);
  const created = childEvents.find((event) => event.type === "run_created");
  if (
    created?.type !== "run_created" ||
    created.parentRunId !== options.context.runId ||
    created.parentCallId !== options.call.callId
  ) {
    return { decision: missingChild(spawned.childRunId) };
  }
  const scopeId = options.scopes.scopeOf(options.context.runId);
  if (created.scopeId !== undefined && created.scopeId !== scopeId) {
    return { decision: missingChild(spawned.childRunId) };
  }
  const completed = parentEvents.some(
    (event) => event.type === "subagent_completed" && event.childRunId === spawned.childRunId,
  );
  return { spawned, childEvents, created, completed };
}

function missingBudgetDecision(childRunId: Id): ToolResumeDecision {
  return {
    kind: "result",
    execution: { outcome: "error", errorCode: "subagent_budget_missing", result: null },
    completion: {
      childRunId,
      outcome: "failed",
      inputTokens: 0,
      outputTokens: 0,
      steps: 0,
    },
  };
}

async function continueExistingChild(
  options: RecoverSubagentOptions,
  existing: ExistingChild,
): Promise<ToolResumeDecision> {
  const { spawned, childEvents, created, completed } = existing;
  if (spawned.budgetLimits === undefined || spawned.budgetDeadlineTs === undefined) {
    return missingBudgetDecision(spawned.childRunId);
  }
  const scopeId = options.scopes.scopeOf(options.context.runId);
  options.scopes.register(spawned.childRunId, scopeId);
  const status = foldRunState(childEvents).status;
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return resultDecision(
      finalizeChild({
        childRunId: spawned.childRunId,
        status,
        events: childEvents,
        hasResultSchema: options.role.resultSchema !== undefined,
      }),
      childEvents,
      completed,
    );
  }

  const input = childEvents.find((event) => event.type === "run_input");
  const callArgs =
    typeof options.call.args === "object" &&
    options.call.args !== null &&
    !Array.isArray(options.call.args)
      ? options.call.args
      : undefined;
  const recoveredInput = recoverInput(input, childEvents, callArgs);
  if (recoveredInput === undefined) {
    return missingChild(spawned.childRunId);
  }
  const parentSpanContext = {
    traceId: spawned.traceId,
    spanId: spawned.spanId,
    traceFlags: 1,
  };
  const request: SubagentRunRequest = {
    runId: spawned.childRunId,
    parentRunId: options.context.runId,
    parentCallId: options.call.callId,
    depth: created.depth,
    scopeId,
    role: options.role,
    budgets: spawned.budgetLimits,
    budgetDeadlineTs: spawned.budgetDeadlineTs,
    input: recoveredInput,
    tools: options.childTools,
    signal: options.context.signal,
    parentSpanContext,
    rootSpanParent: trace.setSpanContext(ROOT_CONTEXT, parentSpanContext),
    rootSpanLinks: [{ context: parentSpanContext }],
  };
  let result: SubagentResult;
  try {
    result = await options.runChild(request);
  } catch (error) {
    if (options.context.signal.reason === "shutdown") {
      return { kind: "shutdown" };
    }
    throw error;
  }
  if (options.context.signal.reason === "shutdown") {
    return { kind: "shutdown" };
  }
  if (result.status === "suspended") {
    return { kind: "suspend" };
  }
  const resumedEvents = await readEvents(options.store, spawned.childRunId);
  return resultDecision(result, resumedEvents, completed);
}

function recoverInput(
  input: Event | undefined,
  childEvents: readonly Event[],
  callArgs: Record<string, JsonValueSchema> | undefined,
): JsonValueSchema | undefined {
  if (input?.type === "run_input") {
    return input.input;
  }
  if (childEvents.length !== 1 || typeof callArgs?.goal !== "string") {
    return undefined;
  }
  return JsonValueSchema.parse({
    goal: callArgs.goal,
    ...(callArgs.inputs === undefined ? {} : { inputs: callArgs.inputs }),
  });
}
