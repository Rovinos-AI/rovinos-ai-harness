// SPDX-License-Identifier: Apache-2.0
import type { Event, RunStatus } from "@harness/schemas";
import { RUN_TRIGGERS, transition } from "./state-machine.js";

/** A tool-intent event that has not yet received a result. */
export type ToolIntentEvent = Extract<Event, { type: "tool_intent" }>;

/** An approval request that has not yet been resolved. */
export type ApprovalRequestedEvent = Extract<Event, { type: "approval_requested" }>;
type CheckpointWrittenEvent = Extract<Event, { type: "checkpoint_written" }>;

/** State derived from the append-only events for one run. */
export interface RunState {
  readonly status: RunStatus;
  readonly nextSeq: number;
  readonly steps: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicros: number;
  };
  readonly pendingToolCalls: Map<ToolIntentEvent["callId"], ToolIntentEvent>;
  readonly pendingApprovals: Map<ApprovalRequestedEvent["approvalId"], ApprovalRequestedEvent>;
  readonly lastCheckpoint?: {
    readonly checkpointId: CheckpointWrittenEvent["checkpointId"];
    readonly atSeq: number;
  };
  readonly segmentId?: Event["segmentId"];
  readonly startedAt?: number;
  readonly lastTs?: number;
}

interface MutableRunState {
  status: RunStatus;
  nextSeq: number;
  steps: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
  };
  pendingToolCalls: Map<ToolIntentEvent["callId"], ToolIntentEvent>;
  pendingApprovals: Map<ApprovalRequestedEvent["approvalId"], ApprovalRequestedEvent>;
  lastCheckpoint?: NonNullable<RunState["lastCheckpoint"]>;
  segmentId?: Event["segmentId"];
  startedAt?: number;
  lastTs?: number;
}

/** Error raised when the event log contains an illegal run-status transition. */
export class CorruptLogError extends Error {
  readonly code = "corrupt_log";

  /** Creates an error for an illegal run-status transition in the event log. */
  constructor() {
    super("Run event log contains an invalid status transition.");
    this.name = "CorruptLogError";
  }
}

function applyStatusEvent(
  state: MutableRunState,
  event: Extract<Event, { type: "run_status_changed" }>,
): MutableRunState {
  const validFrom = event.from === state.status;
  const validTo = RUN_TRIGGERS.some((trigger) => {
    const result = transition(event.from, trigger);
    return result.ok && result.to === event.to;
  });
  if (!validFrom || !validTo) {
    throw new CorruptLogError();
  }
  return { ...state, status: event.to };
}

function applyResponseEvent(
  state: MutableRunState,
  event: Extract<Event, { type: "model_response" }>,
): MutableRunState {
  const costMicros =
    "costMicros" in event && typeof event.costMicros === "number" ? event.costMicros : 0;
  return {
    ...state,
    steps: state.steps + 1,
    usage: {
      inputTokens: state.usage.inputTokens + event.inputTokens,
      outputTokens: state.usage.outputTokens + event.outputTokens,
      costMicros: state.usage.costMicros + costMicros,
    },
  };
}

function applyToolIntent(state: MutableRunState, event: ToolIntentEvent): MutableRunState {
  const pendingToolCalls = new Map(state.pendingToolCalls);
  pendingToolCalls.set(event.callId, event);
  return { ...state, pendingToolCalls };
}

function applyToolResult(
  state: MutableRunState,
  event: Extract<Event, { type: "tool_result" }>,
): MutableRunState {
  const pendingToolCalls = new Map(state.pendingToolCalls);
  pendingToolCalls.delete(event.callId);
  return { ...state, pendingToolCalls };
}

function applyApprovalRequest(
  state: MutableRunState,
  event: ApprovalRequestedEvent,
): MutableRunState {
  const pendingApprovals = new Map(state.pendingApprovals);
  pendingApprovals.set(event.approvalId, event);
  return { ...state, pendingApprovals };
}

function applyApprovalResolution(
  state: MutableRunState,
  event: Extract<Event, { type: "approval_resolved" }>,
): MutableRunState {
  const pendingApprovals = new Map(state.pendingApprovals);
  pendingApprovals.delete(event.approvalId);
  return { ...state, pendingApprovals };
}

function applyEvent(state: MutableRunState, event: Event): MutableRunState {
  const withEnvelope = {
    ...state,
    nextSeq: event.seq + 1,
    segmentId: event.segmentId,
    lastTs: event.ts,
  };
  if (event.type === "run_status_changed") {
    return applyStatusEvent(withEnvelope, event);
  }
  if (event.type === "model_response") {
    return applyResponseEvent(withEnvelope, event);
  }
  if (event.type === "tool_intent") {
    return applyToolIntent(withEnvelope, event);
  }
  if (event.type === "tool_result") {
    return applyToolResult(withEnvelope, event);
  }
  if (event.type === "approval_requested") {
    return applyApprovalRequest(withEnvelope, event);
  }
  if (event.type === "approval_resolved") {
    return applyApprovalResolution(withEnvelope, event);
  }
  if (event.type === "checkpoint_written") {
    return {
      ...withEnvelope,
      lastCheckpoint: { checkpointId: event.checkpointId, atSeq: event.atSeq },
    };
  }
  if (event.type === "run_created" && withEnvelope.startedAt === undefined) {
    return { ...withEnvelope, startedAt: event.ts };
  }
  return withEnvelope;
}

/**
 * Folds events in log order into a fresh run state without mutating the events.
 *
 * @param events - Validated events in append order.
 * @returns State derived from the events.
 * @throws {@link CorruptLogError} when a status event is not a legal transition.
 */
export function foldRunState(events: Iterable<Event>): RunState {
  let state: MutableRunState = {
    status: "pending",
    nextSeq: 0,
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    pendingToolCalls: new Map(),
    pendingApprovals: new Map(),
  };

  for (const event of events) {
    state = applyEvent(state, event);
  }

  return state;
}
