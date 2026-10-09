// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type JsonValue, type RunStatus } from "@harness/schemas";
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
  readonly plan?: JsonValue;
  readonly steps: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicros: number;
  };
  readonly pendingToolCalls: ReadonlyMap<ToolIntentEvent["callId"], ToolIntentEvent>;
  readonly pendingApprovals: ReadonlyMap<
    ApprovalRequestedEvent["approvalId"],
    ApprovalRequestedEvent
  >;
  readonly lastCheckpoint?: {
    readonly checkpointId: CheckpointWrittenEvent["checkpointId"];
    readonly atSeq: number;
  };
  readonly segmentId: Event["segmentId"];
  readonly startedAt: number;
  readonly lastTs: number;
  readonly suspendedTimeMs: number;
  readonly suspendedAt?: number;
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
  segmentId: Event["segmentId"];
  startedAt: number;
  lastTs: number;
  suspendedTimeMs: number;
  suspendedAt?: number;
}

/** Error raised when the event log is corrupt. */
export class CorruptLogError extends HarnessError {
  readonly code = "corrupt_log";

  /** Creates an error for a corrupt event log. */
  constructor() {
    super("Run event log is corrupt.");
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
  if (event.from === "running" && event.to === "suspended") {
    return { ...state, status: event.to, suspendedAt: event.ts };
  }
  if (event.from === "suspended") {
    if (state.suspendedAt === undefined) {
      throw new CorruptLogError();
    }
    const { suspendedAt, ...resumedState } = state;
    return {
      ...resumedState,
      status: event.to,
      suspendedTimeMs: state.suspendedTimeMs + Math.max(0, event.ts - suspendedAt),
    };
  }
  return { ...state, status: event.to };
}

function applyResponseEvent(
  state: MutableRunState,
  event: Extract<Event, { type: "model_response" }>,
): MutableRunState {
  return {
    ...state,
    steps: state.steps + 1,
    usage: {
      inputTokens: state.usage.inputTokens + event.inputTokens,
      outputTokens: state.usage.outputTokens + event.outputTokens,
      costMicros: state.usage.costMicros + (event.costMicros ?? 0),
    },
  };
}

function applyToolIntent(state: MutableRunState, event: ToolIntentEvent): MutableRunState {
  if (state.pendingToolCalls.has(event.callId)) {
    throw new CorruptLogError();
  }
  const pendingToolCalls = new Map(state.pendingToolCalls);
  pendingToolCalls.set(event.callId, event);
  return { ...state, pendingToolCalls };
}

function applyToolResult(
  state: MutableRunState,
  event: Extract<Event, { type: "tool_result" }>,
): MutableRunState {
  if (!state.pendingToolCalls.has(event.callId)) {
    throw new CorruptLogError();
  }
  const pendingToolCalls = new Map(state.pendingToolCalls);
  pendingToolCalls.delete(event.callId);
  return { ...state, pendingToolCalls };
}

function applyApprovalRequest(
  state: MutableRunState,
  event: ApprovalRequestedEvent,
): MutableRunState {
  if (state.pendingApprovals.has(event.approvalId)) {
    throw new CorruptLogError();
  }
  const pendingApprovals = new Map(state.pendingApprovals);
  pendingApprovals.set(event.approvalId, event);
  return { ...state, pendingApprovals };
}

function applyApprovalResolution(
  state: MutableRunState,
  event: Extract<Event, { type: "approval_resolved" }>,
): MutableRunState {
  if (!state.pendingApprovals.has(event.approvalId)) {
    throw new CorruptLogError();
  }
  const pendingApprovals = new Map(state.pendingApprovals);
  pendingApprovals.delete(event.approvalId);
  return { ...state, pendingApprovals };
}

function applyEvent(state: MutableRunState, event: Event, runId: Event["runId"]): MutableRunState {
  if (event.seq !== state.nextSeq || event.runId !== runId || event.type === "run_created") {
    throw new CorruptLogError();
  }
  const withEnvelope = {
    ...state,
    nextSeq: state.nextSeq + 1,
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
  return withEnvelope;
}

/**
 * Folds events in log order into a fresh run state without mutating the events.
 *
 * @param events - Validated events in append order.
 * @returns State derived from the events.
 * @throws {@link CorruptLogError} when the log is empty or contains corrupt events.
 */
export function foldRunState(events: Iterable<Event>): RunState {
  const iterator = events[Symbol.iterator]();
  const first = iterator.next();
  if (first.done === true || first.value.type !== "run_created" || first.value.seq !== 0) {
    throw new CorruptLogError();
  }

  const runId = first.value.runId;
  let state: MutableRunState = {
    status: "pending",
    nextSeq: 1,
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    pendingToolCalls: new Map(),
    pendingApprovals: new Map(),
    segmentId: first.value.segmentId,
    startedAt: first.value.ts,
    lastTs: first.value.ts,
    suspendedTimeMs: 0,
  };

  for (;;) {
    const next = iterator.next();
    if (next.done === true) {
      break;
    }
    state = applyEvent(state, next.value, runId);
  }

  return state;
}
