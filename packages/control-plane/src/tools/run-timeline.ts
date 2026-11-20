// SPDX-License-Identifier: Apache-2.0
import type { Event, Id } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import { getRunTimelineInputSchema, getRunTimelineOutputSchema } from "../schemas.js";
import type { GetRunTimelineOutput } from "../schemas.js";
import { readRunState } from "./run-state.js";

type TimelineStep = GetRunTimelineOutput["steps"][number];

interface TimelineState {
  readonly steps: TimelineStep[];
  readonly requests: Map<string, number>;
  readonly calls: Map<string, number>;
  readonly approvals: Map<string, number>;
  readonly inputs: Map<string, number>;
  readonly subagents: Map<string, number>;
}

type TimelineHandler = (event: Event, state: TimelineState) => boolean;

function createTimelineState(): TimelineState {
  return {
    steps: [],
    requests: new Map(),
    calls: new Map(),
    approvals: new Map(),
    inputs: new Map(),
    subagents: new Map(),
  };
}

function addStep(state: TimelineState, step: TimelineStep): number {
  state.steps.push(step);
  return state.steps.length - 1;
}

function updateStep(index: number | undefined, state: TimelineState, update: Partial<TimelineStep>): void {
  if (index === undefined) {
    return;
  }
  const current = state.steps[index];
  if (current !== undefined) {
    state.steps[index] = { ...current, ...update };
  }
}

function handleModelEvent(event: Event, state: TimelineState): boolean {
  if (event.type === "model_request") {
    state.requests.set(
      event.requestId,
      addStep(state, {
        type: "model_call",
        seq: event.seq,
        lastSeq: event.seq,
        startedAt: event.ts,
        status: "running",
        provider: event.provider,
        model: event.model,
        requestId: event.requestId,
      }),
    );
    return true;
  }
  if (event.type !== "model_response") {
    return false;
  }
  const index = state.requests.get(event.requestId);
  const existing = index === undefined ? undefined : state.steps[index];
  const stepIndex =
    existing === undefined
      ? addStep(state, {
          type: "model_call",
          seq: event.seq,
          lastSeq: event.seq,
          startedAt: Math.max(0, event.ts - event.latencyMs),
          status: "completed",
          provider: event.provider,
          model: event.model,
          requestId: event.requestId,
        })
      : index;
  updateStep(stepIndex, state, {
    lastSeq: event.seq,
    endedAt: event.ts,
    durationMs: event.latencyMs,
    status: "completed",
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cost: event.cost,
  });
  return true;
}

function toolIntentStatus(decision: "allow" | "ask" | "deny"): "denied" | "pending" | "running" {
  if (decision === "deny") {
    return "denied";
  }
  return decision === "ask" ? "pending" : "running";
}

function toolResultStatus(outcome: "ok" | "error" | "denied" | "timeout"): "failed" | "denied" | "completed" {
  if (outcome === "error" || outcome === "timeout") {
    return "failed";
  }
  return outcome === "denied" ? "denied" : "completed";
}

function handleToolEvent(event: Event, state: TimelineState): boolean {
  if (event.type === "tool_intent") {
    state.calls.set(
      event.callId,
      addStep(state, {
        type: "tool_call",
        seq: event.seq,
        lastSeq: event.seq,
        startedAt: event.ts,
        status: toolIntentStatus(event.policyDecision),
        toolId: event.toolId,
        policyDecision: event.policyDecision,
      }),
    );
    return true;
  }
  if (event.type === "tool_execution_started") {
    updateStep(state.calls.get(event.callId), state, {
      lastSeq: event.seq,
      startedAt: event.ts,
      status: "running",
    });
    return true;
  }
  if (event.type !== "tool_result") {
    return false;
  }
  const index = state.calls.get(event.callId);
  const existing = index === undefined ? undefined : state.steps[index];
  const stepIndex =
    existing === undefined
      ? addStep(state, {
          type: "tool_call",
          seq: event.seq,
          lastSeq: event.seq,
          startedAt: Math.max(0, event.ts - event.latencyMs),
          status: "completed",
          toolId: event.toolId,
        })
      : index;
  updateStep(stepIndex, state, {
    lastSeq: event.seq,
    endedAt: event.ts,
    durationMs: event.latencyMs,
    status: toolResultStatus(event.outcome),
    outcome: event.outcome,
  });
  return true;
}

function handleApprovalEvent(event: Event, state: TimelineState): boolean {
  if (event.type === "approval_requested") {
    state.approvals.set(
      event.approvalId,
      addStep(state, {
        type: "approval_wait",
        seq: event.seq,
        lastSeq: event.seq,
        startedAt: event.ts,
        status: "pending",
        approvalId: event.approvalId,
      }),
    );
    return true;
  }
  if (event.type !== "approval_resolved") {
    return false;
  }
  updateStep(state.approvals.get(event.approvalId), state, {
    lastSeq: event.seq,
    endedAt: event.ts,
    durationMs: event.waitMs,
    status: event.decision === "deny" ? "denied" : "approved",
    outcome: event.decision,
  });
  return true;
}

function handleInputEvent(event: Event, state: TimelineState): boolean {
  if (event.type === "input_requested") {
    state.inputs.set(
      event.requestId,
      addStep(state, {
        type: "input_wait",
        seq: event.seq,
        lastSeq: event.seq,
        startedAt: event.ts,
        status: "pending",
        requestId: event.requestId,
      }),
    );
    return true;
  }
  if (event.type !== "input_resolved") {
    return false;
  }
  updateStep(state.inputs.get(event.requestId), state, {
    lastSeq: event.seq,
    endedAt: event.ts,
    durationMs: event.waitMs,
    status: inputResolutionStatus(event.action),
    outcome: event.action,
  });
  return true;
}

function inputResolutionStatus(action: "accept" | "decline" | "cancel"): "accepted" | "declined" | "cancelled" {
  switch (action) {
    case "accept":
      return "accepted";
    case "decline":
      return "declined";
    case "cancel":
      return "cancelled";
  }
}

function subagentBudgetFields(
  limits: Extract<Event, { readonly type: "subagent_spawned" }>,
): Partial<TimelineStep> {
  const fields: Partial<TimelineStep> = {};
  if (limits.budgetLimits?.maxSteps !== undefined) {
    fields.maxSteps = limits.budgetLimits.maxSteps;
  }
  if (limits.budgetLimits?.maxCostUsd !== undefined) {
    fields.maxCostUsd = limits.budgetLimits.maxCostUsd;
  }
  if (limits.budgetLimits?.maxWallClockMs !== undefined) {
    fields.maxWallClockMs = limits.budgetLimits.maxWallClockMs;
  }
  if (limits.budgetDeadlineTs !== undefined) {
    fields.budgetDeadlineTs = limits.budgetDeadlineTs;
  }
  return fields;
}

function handleSubagentEvent(event: Event, state: TimelineState): boolean {
  if (event.type === "subagent_spawned") {
    state.subagents.set(
      event.childRunId,
      addStep(state, {
        type: "subagent_spawn",
        seq: event.seq,
        lastSeq: event.seq,
        startedAt: event.ts,
        status: "running",
        childRunId: event.childRunId,
        role: event.role,
        ...subagentBudgetFields(event),
      }),
    );
    return true;
  }
  if (event.type !== "subagent_completed") {
    return false;
  }
  const index = state.subagents.get(event.childRunId);
  const existing = index === undefined ? undefined : state.steps[index];
  addStep(state, {
    type: "subagent_completion",
    seq: event.seq,
    lastSeq: event.seq,
    startedAt: existing?.startedAt ?? event.ts,
    endedAt: event.ts,
    ...(existing === undefined ? {} : { durationMs: Math.max(0, event.ts - existing.startedAt) }),
    status: event.outcome,
    childRunId: event.childRunId,
    outcome: event.outcome,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.steps === undefined ? {} : { stepsUsed: event.steps }),
    costMicros: event.cost.knownMicros + event.cost.estimatedMicros + event.cost.partialMicros,
  });
  return true;
}

function handleCheckpointEvent(event: Event, state: TimelineState): boolean {
  if (event.type !== "checkpoint_written") {
    return false;
  }
  addStep(state, {
    type: "checkpoint",
    seq: event.seq,
    lastSeq: event.seq,
    startedAt: event.ts,
    status: "completed",
  });
  return true;
}

function handleCompactionEvent(event: Event, state: TimelineState): boolean {
  if (event.type !== "context_compacted") {
    return false;
  }
  addStep(state, {
    type: "compaction",
    seq: event.seq,
    lastSeq: event.seq,
    startedAt: event.ts,
    status: "completed",
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cost: event.cost,
  });
  return true;
}

function handleBudgetEvent(event: Event, state: TimelineState): boolean {
  if (event.type !== "budget_exceeded") {
    return false;
  }
  addStep(state, {
    type: "budget_exceeded",
    seq: event.seq,
    lastSeq: event.seq,
    startedAt: event.ts,
    status: "exceeded",
    budget: event.budget,
    limit: event.limit,
    observed: event.observed,
  });
  return true;
}

function handleRunStatusEvent(event: Event, state: TimelineState): boolean {
  if (event.type !== "run_status_changed") {
    return false;
  }
  addStep(state, {
    type: "run_status",
    seq: event.seq,
    lastSeq: event.seq,
    startedAt: event.ts,
    status: event.to,
  });
  return true;
}

const timelineHandlers: readonly TimelineHandler[] = [
  handleModelEvent,
  handleToolEvent,
  handleApprovalEvent,
  handleInputEvent,
  handleSubagentEvent,
  handleCheckpointEvent,
  handleCompactionEvent,
  handleBudgetEvent,
  handleRunStatusEvent,
];

/** Builds a metadata-only timeline from the validated events in one run. */
export function groupRunTimeline(events: readonly Event[], sinceSeq?: number): TimelineStep[] {
  const state = createTimelineState();
  for (const event of events) {
    for (const handler of timelineHandlers) {
      if (handler(event, state)) {
        break;
      }
    }
  }
  return state.steps.filter((step) => sinceSeq === undefined || step.lastSeq > sinceSeq);
}

/** Reads the event log and returns timeline metadata without event content. */
export async function getRunTimeline(
  store: EventStore,
  input: { readonly runId: Id; readonly sinceSeq?: number },
): Promise<GetRunTimelineOutput | undefined> {
  const parsed = getRunTimelineInputSchema.parse(input);
  const run = await readRunState(store, parsed.runId);
  if (run === undefined) {
    return undefined;
  }
  const lastEvent = run.events.at(-1);
  if (lastEvent === undefined) {
    return undefined;
  }
  return getRunTimelineOutputSchema.parse({
    runId: parsed.runId,
    status: run.state.status,
    lastSeq: lastEvent.seq,
    steps: groupRunTimeline(run.events, parsed.sinceSeq),
    usage: {
      steps: run.state.steps,
      inputTokens: run.state.usage.inputTokens,
      outputTokens: run.state.usage.outputTokens,
      cost: run.state.usage.cost,
    },
  });
}
