// SPDX-License-Identifier: Apache-2.0
import {
  JsonValue as JsonValueSchema,
  type Event,
  type Id,
  type RunConfig,
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

interface RecoverSubagentOptions {
  readonly store: EventStore;
  readonly scopes: RunScopeRegistry;
  readonly childTools: ToolPort;
  readonly runConfig: RunConfig;
  readonly role: ResolvedRole;
  readonly call: ModelToolCall;
  readonly state: RunState;
  readonly context: ToolResumeContext;
  readonly runChild: SubagentRunner;
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

function missingChild(): ToolResumeDecision {
  return {
    kind: "result",
    execution: { outcome: "error", errorCode: "subagent_missing", result: null },
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
  if (spawned === undefined || spawned.type !== "subagent_spawned") {
    return { kind: "rerun" };
  }
  if (spawned.role !== options.role.id) {
    return missingChild();
  }

  const childEvents = await readEvents(options.store, spawned.childRunId);
  if (childEvents.length === 0) {
    return missingChild();
  }
  const created = childEvents.find((event) => event.type === "run_created");
  if (
    created?.type !== "run_created" ||
    created.parentRunId !== options.context.runId ||
    created.parentCallId !== options.call.callId
  ) {
    return missingChild();
  }

  const scopeId = options.scopes.scopeOf(options.context.runId);
  if (created.scopeId !== undefined && created.scopeId !== scopeId) {
    return missingChild();
  }
  options.scopes.register(spawned.childRunId, scopeId);
  const completed = parentEvents.some(
    (event) => event.type === "subagent_completed" && event.childRunId === spawned.childRunId,
  );
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
  if (input?.type !== "run_input") {
    return missingChild();
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
    depth: created.depth ?? 1,
    scopeId,
    role: options.role,
    budgets: spawned.budgetLimits ?? options.runConfig.budgets,
    budgetDeadlineTs: spawned.budgetDeadlineTs ?? Number.POSITIVE_INFINITY,
    input: input.input,
    tools: options.childTools,
    signal: options.context.signal,
    parentSpanContext,
    rootSpanParent: trace.setSpanContext(ROOT_CONTEXT, parentSpanContext),
    rootSpanLinks: [{ context: parentSpanContext }],
  };
  const result = await options.runChild(request);
  if (result.status === "suspended") {
    return { kind: "suspend" };
  }
  const resumedEvents = await readEvents(options.store, spawned.childRunId);
  return resultDecision(result, resumedEvents, completed);
}
