// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type Id, type Snapshot } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { WorkspaceSnapshotPort } from "@harness/sandbox";
import { activeRuns } from "@harness/telemetry";
import { applyResolvedApprovals } from "./approvals.js";
import { BudgetTracker } from "./budgets.js";
import { Checkpointer } from "./checkpoint.js";
import { continueRunLoop, type RunLoopExecutionOptions, type RunLoopResult } from "./loop.js";
import { recordBudgetFailureAndCheckpoint } from "./steps/model-preflight.js";
import { LeaseLostError, RunRecorder, type EventPartial } from "./recorder.js";
import { planDanglingIntents, type ResumePolicy } from "./resume-policy.js";
import { foldRunState, isTerminalRunState, type RunState } from "./run-state.js";
import { RUN_SPAN } from "./spans.js";
import { applyDanglingIntents } from "./steps/resume-tool-step.js";
import { suspendForShutdown } from "./steps/shutdown.js";
import type { RunScopeRegistry } from "./subagent/scope.js";
import {
  previousSegmentLink,
  readRunEvents,
  restoreRunScope,
  restoreWorkspaceSnapshot,
} from "./resume-history.js";
import { claimResumeLock } from "./resume-lock.js";

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
    super("Only pending, running, or suspended runs can be resumed.");
    this.name = "RunNotResumableError";
  }
}

/** Error raised when a suspended run is waiting only for unresolved approvals. */
export class RunAwaitingApprovalError extends HarnessError {
  readonly code = "run_awaiting_approval";

  /** Creates the awaiting-approval resume error. */
  constructor() {
    super("The run cannot progress until its pending approval is resolved.");
    this.name = "RunAwaitingApprovalError";
  }
}

/** Error raised when a suspended run still has unresolved human inputs. */
export class RunAwaitingInputError extends HarnessError {
  readonly code = "run_awaiting_input";

  /** Creates the awaiting-input resume error. */
  constructor() {
    super("The run cannot progress until its pending input is resolved.");
    this.name = "RunAwaitingInputError";
  }
}

const RESUME_LEASE_MS = 30_000;
const RESUME_LEASE_RENEW_MS = 10_000;

/** Inputs for resuming an existing run. */
export interface ResumeRunOptions extends Omit<RunLoopExecutionOptions, "recorder"> {
  readonly store: EventStore;
  readonly runId: Id;
  readonly scopes?: RunScopeRegistry;
  /** Policy for dangling non-idempotent tool intents; defaults to escalation. */
  readonly resumePolicy?: ResumePolicy;
  /** Restores the latest workspace archive even when the workspace still exists. */
  readonly restoreOnResume?: boolean;
  readonly workspaceSnapshotter?: WorkspaceSnapshotPort;
  /** Called immediately after this worker wins the durable resume claim. */
  readonly onClaimed?: () => void;
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

function hasResolvedApprovalToApply(state: RunState): boolean {
  for (const resolution of state.resolvedApprovals.values()) {
    const approval = state.approvalRequests.get(resolution.approvalId);
    const intent = approval === undefined ? undefined : state.pendingToolCalls.get(approval.callId);
    if (approval !== undefined && intent !== undefined && intent.seq < approval.seq) {
      return true;
    }
  }
  return false;
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

interface ResumeHistory {
  readonly events: Event[];
  readonly snapshot: Snapshot | undefined;
  readonly state: RunState;
  readonly head: number;
}

async function readResumeHistory(options: ResumeRunOptions): Promise<ResumeHistory> {
  const [events, snapshot, head] = await Promise.all([
    readRunEvents(options.store, options.runId),
    options.store.latestSnapshot(options.runId),
    options.store.head(options.runId),
  ]);
  if (options.scopes !== undefined) {
    await restoreRunScope(options.store, options.runId, events, options.scopes);
  }
  const state = foldRunState(events);
  if (isTerminalRunState(state)) {
    throw new RunAlreadyTerminalError();
  }
  if (state.nextSeq !== head) {
    throw new ResumeConflictError();
  }
  if (
    state.status === "suspended" &&
    state.pendingApprovals.size > 0 &&
    withoutApprovalIntents(state).pendingToolCalls.size === 0 &&
    !hasResolvedApprovalToApply(state)
  ) {
    throw new RunAwaitingApprovalError();
  }
  if (state.pendingInputs.size > 0) {
    throw new RunAwaitingInputError();
  }
  return { events, snapshot, state, head };
}

function claimEvents(state: RunState): EventPartial[] {
  if (state.status === "pending") {
    return [
      {
        type: "run_status_changed",
        v: 1,
        from: "pending",
        to: "running",
        reason: "start",
      },
    ];
  }
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
  await restoreWorkspaceSnapshot(execution);
  await options.context.restore(snapshot?.context, eventsAfterSnapshot);

  const budgetTracker = new BudgetTracker(options.budgets, undefined, options.deadlineTs);
  const beforeToolExecution = async (): Promise<void> => {
    const violation = budgetTracker.checkWithOpenChildren(events, options.clock.now());
    if (!violation.ok) {
      await recordBudgetFailureAndCheckpoint(recorder, events, violation, checkpointer);
      throw new ResumeBudgetExceededError();
    }
  };
  const recoveryResult = await applyResumeActions(execution, beforeToolExecution);
  if (recoveryResult !== undefined) {
    return recoveryResult;
  }

  let resumedState = foldRunState(events);
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

async function applyResumeActions(
  execution: ResumeExecution,
  beforeToolExecution: () => Promise<void>,
): Promise<Event | undefined> {
  const { options, recorder, events, checkpointer } = execution;
  const danglingState = withoutApprovalIntents(foldRunState(events));
  const actions = planDanglingIntents(
    danglingState,
    options.tool,
    options.resumePolicy ?? "escalate",
  );
  try {
    await applyDanglingIntents(
      {
        recorder,
        tool: options.tool,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        checkpointer,
        clock: options.clock,
        runId: options.runId,
        ids: options.ids,
        signal: options.signal,
        ...(options.depth === undefined ? {} : { depth: options.depth }),
        history: events,
        beforeToolExecution,
        onEvents: (recorded) => events.push(...recorded),
      },
      danglingState,
      actions,
    );
    if (options.signal.reason === "shutdown") {
      return await suspendForShutdown(recorder, events, checkpointer);
    }
    await applyResolvedApprovals(
      {
        recorder,
        tool: options.tool,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        clock: options.clock,
        runId: options.runId,
        ids: options.ids,
        checkpointer,
        signal: options.signal,
        ...(options.depth === undefined ? {} : { depth: options.depth }),
        history: events,
        beforeToolExecution,
        onEvents: (recorded) => events.push(...recorded),
      },
      foldRunState(events),
    );
  } catch (error) {
    if (!(error instanceof ResumeBudgetExceededError)) {
      throw error;
    }
    const failed = events.at(-1);
    if (failed === undefined) {
      throw new Error("Expected the budget failure event.");
    }
    return failed;
  }
  return undefined;
}

class ResumeBudgetExceededError extends Error {}

async function claimAndContinue(execution: ResumeExecution): Promise<Event> {
  try {
    execution.events.push(...(await execution.recorder.recordBatch(claimEvents(execution.state))));
    execution.options.onClaimed?.();
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
  const release = claimResumeLock(options.store, options.runId, () => new ResumeConflictError());
  return withResumeLease(options, release);
}

async function withResumeLease(
  options: ResumeRunOptions,
  release: () => void,
): Promise<RunLoopResult> {
  const leaseOwner = options.ids.next();
  const leaseController = new AbortController();
  let leaseClaimed = false;
  let renewalTimer: ReturnType<typeof setInterval> | undefined;
  try {
    leaseClaimed = await options.store.claimRunExecution(
      options.runId,
      leaseOwner,
      options.clock.now(),
      RESUME_LEASE_MS,
    );
    if (!leaseClaimed) {
      throw new ResumeConflictError();
    }
    const executionOptions = {
      ...options,
      signal: AbortSignal.any([options.signal, leaseController.signal]),
    };
    renewalTimer = startLeaseRenewal(options, leaseOwner, leaseController);
    renewalTimer.unref();
    const { events, snapshot, state, head } = await readResumeHistory(executionOptions);
    return await resumeFromHistory(executionOptions, leaseOwner, { events, snapshot, state, head });
  } finally {
    if (renewalTimer !== undefined) {
      clearInterval(renewalTimer);
    }
    if (leaseClaimed) {
      await options.store.releaseRunExecution(options.runId, leaseOwner);
    }
    release();
  }
}

function startLeaseRenewal(
  options: ResumeRunOptions,
  leaseOwner: Id,
  leaseController: AbortController,
): ReturnType<typeof setInterval> {
  let renewalPending = false;
  return setInterval(() => {
    if (renewalPending) {
      return;
    }
    renewalPending = true;
    void options.store
      .renewRunExecution(options.runId, leaseOwner, options.clock.now(), RESUME_LEASE_MS)
      .then((renewed) => {
        if (!renewed) {
          leaseController.abort("resume_lease_lost");
        }
      })
      .catch(() => {
        leaseController.abort("resume_lease_lost");
      })
      .finally(() => {
        renewalPending = false;
      });
  }, RESUME_LEASE_RENEW_MS);
}

async function resumeFromHistory(
  options: ResumeRunOptions,
  leaseOwner: Id,
  history: ResumeHistory,
): Promise<RunLoopResult> {
  const { events, snapshot, state, head } = history;
  const recorder = new RunRecorder(
    options.store,
    options.runId,
    options.ids.next(),
    head,
    options.clock,
    undefined,
    leaseOwner,
    options.signal,
  );
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
    ...(options.snapshotKeep === undefined ? {} : { snapshotKeep: options.snapshotKeep }),
    ...(options.workspaceSnapshotter === undefined
      ? {}
      : { workspaceSnapshotter: options.workspaceSnapshotter }),
  });
  const execution: ResumeExecution = {
    options,
    state,
    events,
    snapshot,
    eventsAfterSnapshot:
      snapshot === undefined
        ? events.slice()
        : events.filter((event) => event.seq > snapshot.atSeq),
    recorder,
    checkpointer,
  };
  await activeRuns.track(
    options.runId,
    () =>
      recorder.withStepSpan(RUN_SPAN, {}, () => claimAndContinue(execution), {
        links: [previousSegmentLink(events, snapshot?.traceparent)],
      }),
    () => isTerminalRunState(foldRunState(events)),
  );
  return resultForResume(events, newEventStart);
}
