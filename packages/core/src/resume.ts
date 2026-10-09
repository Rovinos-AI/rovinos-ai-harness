// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type Id, type Snapshot } from "@harness/schemas";
import type { Link } from "@opentelemetry/api";
import type { EventStore } from "@harness/store";
import { applyResolvedApprovals } from "./approvals.js";
import { Checkpointer } from "./checkpoint.js";
import { continueRunLoop, type RunLoopExecutionOptions, type RunLoopResult } from "./loop.js";
import { LeaseLostError, RunRecorder, type EventPartial } from "./recorder.js";
import { planDanglingIntents, type ResumePolicy } from "./resume-policy.js";
import { foldRunState, type RunState } from "./run-state.js";
import { RUN_SPAN } from "./spans.js";
import { applyDanglingIntents } from "./steps/tool-step.js";

/** Error raised when attempting to resume a completed, failed, or cancelled run. */
export class RunAlreadyTerminalError extends HarnessError {
  readonly code = "run_already_terminal";

  /** Creates the terminal-run resume error. */
  constructor() {
    super("A terminal run cannot be resumed.");
    this.name = "RunAlreadyTerminalError";
  }
}

/** Error raised when another writer claims the run before this resumer. */
export class ResumeConflictError extends HarnessError {
  readonly code = "resume_conflict";

  /** Creates the concurrent-resume conflict error. */
  constructor() {
    super("Another worker changed the run before it could be resumed.");
    this.name = "ResumeConflictError";
  }
}

/** Error raised when a run is neither interrupted nor suspended. */
export class RunNotResumableError extends HarnessError {
  readonly code = "run_not_resumable";

  /** Creates the invalid run-state resume error. */
  constructor() {
    super("Only running or suspended runs can be resumed.");
    this.name = "RunNotResumableError";
  }
}

/** Inputs for resuming an existing run. */
export interface ResumeRunOptions extends Omit<RunLoopExecutionOptions, "recorder"> {
  readonly store: EventStore;
  readonly runId: Id;
  /** Policy for dangling non-idempotent tool intents; defaults to escalation. */
  readonly resumePolicy?: ResumePolicy;
}

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

function linkFromTraceparent(traceparent: string): Link | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u.exec(traceparent);
  const traceId = match?.[1];
  const spanId = match?.[2];
  const flags = match?.[3];
  if (traceId === undefined || spanId === undefined || flags === undefined) {
    return undefined;
  }
  return {
    context: {
      traceId,
      spanId,
      traceFlags: Number.parseInt(flags, 16),
      isRemote: true,
    },
  };
}

function previousSegmentLink(events: readonly Event[], traceparent?: string): Link {
  const checkpointLink = traceparent === undefined ? undefined : linkFromTraceparent(traceparent);
  if (checkpointLink !== undefined) {
    return checkpointLink;
  }
  const last = events.at(-1);
  if (last === undefined) {
    throw new Error("Expected a prior run event.");
  }
  return {
    context: {
      traceId: last.traceId,
      spanId: last.spanId,
      traceFlags: 1,
      isRemote: true,
    },
  };
}

function withoutApprovalIntents(state: RunState): RunState {
  const approvedCalls = new Set(
    Array.from(state.approvalRequests.values(), (approval) => approval.callId),
  );
  const pendingToolCalls = new Map(
    Array.from(state.pendingToolCalls).filter(([callId]) => !approvedCalls.has(callId)),
  );
  return { ...state, pendingToolCalls };
}

function resultForResume(events: readonly Event[], firstNewEvent: number): RunLoopResult {
  const state = foldRunState(events);
  return {
    status: state.status,
    approvalIds: Array.from(state.pendingApprovals.keys()),
    state,
    events: events.slice(firstNewEvent),
  };
}

interface ResumeExecution {
  readonly options: ResumeRunOptions;
  readonly state: RunState;
  readonly events: Event[];
  readonly snapshot: Snapshot | undefined;
  readonly eventsAfterSnapshot: Event[];
  readonly recorder: RunRecorder;
  readonly checkpointer: Checkpointer;
}

async function readResumeHistory(options: ResumeRunOptions): Promise<{
  readonly events: Event[];
  readonly snapshot: Snapshot | undefined;
  readonly state: RunState;
  readonly head: number;
}> {
  const [events, snapshot, head] = await Promise.all([
    readEvents(options.store, options.runId),
    options.store.latestSnapshot(options.runId),
    options.store.head(options.runId),
  ]);
  const state = foldRunState(events);
  if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
    throw new RunAlreadyTerminalError();
  }
  if (state.status !== "running" && state.status !== "suspended") {
    throw new RunNotResumableError();
  }
  if (state.nextSeq !== head) {
    throw new ResumeConflictError();
  }
  return { events, snapshot, state, head };
}

function claimEvents(state: RunState): EventPartial[] {
  if (state.status === "running") {
    return [
      {
        type: "run_status_changed",
        v: 1,
        from: "running",
        to: "suspended",
        reason: "interrupted",
      },
      {
        type: "run_status_changed",
        v: 1,
        from: "suspended",
        to: "running",
        reason: "resumed",
      },
    ];
  }
  return [
    {
      type: "run_status_changed",
      v: 1,
      from: "suspended",
      to: "running",
      reason: "resumed",
    },
  ];
}

async function continueClaimedRun(execution: ResumeExecution): Promise<Event> {
  const { options, recorder, events, snapshot, eventsAfterSnapshot, checkpointer } = execution;
  await options.context.restore(snapshot?.context, eventsAfterSnapshot);

  const danglingState = withoutApprovalIntents(foldRunState(events));
  const actions = planDanglingIntents(
    danglingState,
    options.tool,
    options.resumePolicy ?? "escalate",
  );
  events.push(
    ...(await applyDanglingIntents(
      {
        recorder,
        tool: options.tool,
        clock: options.clock,
        runId: options.runId,
        ids: options.ids,
        signal: options.signal,
      },
      danglingState,
      actions,
    )),
  );

  let resumedState = foldRunState(events);
  events.push(
    ...(await applyResolvedApprovals(
      {
        recorder,
        tool: options.tool,
        clock: options.clock,
        runId: options.runId,
        signal: options.signal,
      },
      resumedState,
    )),
  );
  resumedState = foldRunState(events);

  if (resumedState.pendingApprovals.size > 0 && resumedState.status === "running") {
    events.push(
      await recorder.record({
        type: "run_status_changed",
        v: 1,
        from: "running",
        to: "suspended",
        reason: "awaiting_approval",
      }),
    );
    resumedState = foldRunState(events);
  }
  if (resumedState.status === "suspended") {
    const checkpoint = await checkpointer.write(resumedState, "suspended");
    events.push(checkpoint);
    return checkpoint;
  }
  return continueRunLoop({ ...options, recorder }, events, options.runId);
}

async function claimAndContinue(execution: ResumeExecution): Promise<Event> {
  try {
    execution.events.push(...(await execution.recorder.recordBatch(claimEvents(execution.state))));
  } catch (error) {
    if (error instanceof LeaseLostError) {
      throw new ResumeConflictError();
    }
    throw error;
  }
  return continueClaimedRun(execution);
}

/**
 * Claims an interrupted or suspended run and continues execution from its latest checkpoint.
 *
 * @param options - Store, run identifier, runtime ports, and resume settings.
 * @returns The folded final run state and events appended by this resume attempt.
 * @throws RunAlreadyTerminalError when the run has already finished.
 * @throws ResumeConflictError when another writer wins the resume claim.
 */
export async function resumeRun(options: ResumeRunOptions): Promise<RunLoopResult> {
  const { events, snapshot, state, head } = await readResumeHistory(options);
  const segmentId = options.ids.next();
  const recorder = new RunRecorder(options.store, options.runId, segmentId, head, options.clock);
  const newEventStart = events.length;
  const checkpointer = new Checkpointer({
    recorder,
    runId: options.runId,
    context: options.context,
    ids: options.ids,
    clock: options.clock,
    ...(options.checkpointEveryEvents === undefined
      ? {}
      : { checkpointEveryEvents: options.checkpointEveryEvents }),
  });
  const eventsAfterSnapshot =
    snapshot === undefined ? events.slice() : events.filter((event) => event.seq > snapshot.atSeq);
  const execution: ResumeExecution = {
    options,
    state,
    events,
    snapshot,
    eventsAfterSnapshot,
    recorder,
    checkpointer,
  };
  await recorder.withStepSpan(RUN_SPAN, {}, () => claimAndContinue(execution), [
    previousSegmentLink(events, snapshot?.traceparent),
  ]);

  return resultForResume(events, newEventStart);
}
