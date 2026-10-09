// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  type Code,
  type Event,
  type Id,
  type JsonValue,
  type RunConfig,
} from "@harness/schemas";
import { BudgetTracker, type BudgetViolation } from "./budgets.js";
import { Checkpointer } from "./checkpoint.js";
import { foldRunState, type RunState } from "./run-state.js";
import type { Clock, EventPartial, RunRecorder } from "./recorder.js";
import { RUN_SPAN } from "./spans.js";
import { modelStep } from "./steps/model-step.js";
import { toolStep } from "./steps/tool-step.js";
import type {
  ContextPort,
  IdGenerator,
  ModelCompletion,
  ModelPort,
  NewRunMetadata,
  ToolPort,
} from "./ports.js";

/** Dependencies and initial input for a new run. */
export interface RunLoopOptions extends NewRunMetadata {
  readonly recorder: RunRecorder;
  readonly clock: Clock;
  readonly model: ModelPort;
  readonly tool: ToolPort;
  readonly context: ContextPort;
  readonly ids: IdGenerator;
  readonly goal: JsonValue;
  readonly signal: AbortSignal;
  /** Per-run limits sourced from the validated run configuration. */
  readonly budgets: RunConfig["budgets"];
  readonly checkpointEveryEvents?: RunConfig["checkpointEveryEvents"];
  readonly role?: Code;
  readonly provider?: Code;
  readonly modelName?: Code;
}

/** Execution options shared by new runs and resumptions. */
export type RunLoopExecutionOptions = Omit<RunLoopOptions, "configHash" | "policyVersion">;

/** Final state and ordered events produced by a run. */
export interface RunLoopResult {
  readonly status: RunState["status"];
  readonly approvalIds: readonly Id[];
  readonly state: RunState;
  readonly events: readonly Event[];
}

interface RunLoopExecution {
  readonly runId: Event["runId"];
  readonly checkpointer: Checkpointer;
  readonly budgetTracker: BudgetTracker;
}

class RunAbortedError extends HarnessError {
  readonly code = "run_aborted";

  constructor() {
    super("Run was aborted.");
  }
}

/**
 * Runs a new model-driven run until a final answer or a configured budget is exceeded.
 *
 * @param options - Ports, recorder, deterministic ID source, and initial run input.
 * @returns The final folded state and all events created by this invocation.
 */
export async function runLoop(options: RunLoopOptions): Promise<RunLoopResult> {
  const events: Event[] = [];
  let result: RunLoopResult | undefined;
  const budgetTracker = new BudgetTracker(options.budgets);
  const startEvents: EventPartial[] = [
    {
      type: "run_created",
      v: 1,
      configHash: options.configHash,
      policyVersion: options.policyVersion,
    },
    { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
  ];
  await options.recorder.withStepSpan(RUN_SPAN, {}, async () => {
    const recorded = await options.recorder.recordBatch(startEvents);
    const last = recorded.at(-1);
    if (last === undefined) {
      throw new Error("Expected run creation events.");
    }
    events.push(...recorded);
    const runId = last.runId;
    const ended = await continueRunLoop(options, events, runId, budgetTracker);
    const state = foldRunState(events);
    result = {
      status: state.status,
      approvalIds: Array.from(state.pendingApprovals.keys()),
      state,
      events,
    };
    return ended;
  });

  if (result === undefined) {
    throw new Error("Expected the run loop to record an outcome.");
  }
  return result;
}

/**
 * Continues a run from its already-folded event history within the active run span.
 *
 * @param options - Ports and runtime settings for this segment.
 * @param events - Complete validated history, extended in place by the loop.
 * @param runId - Identifier of the existing run.
 * @param budgetTracker - Budget tracker initialized for this run or resume.
 * @returns The final event produced by the continued loop.
 */
export async function continueRunLoop(
  options: RunLoopExecutionOptions,
  events: Event[],
  runId: Id,
  budgetTracker = new BudgetTracker(options.budgets),
): Promise<Event> {
  const checkpointer = new Checkpointer({
    recorder: options.recorder,
    runId,
    context: options.context,
    ids: options.ids,
    clock: options.clock,
    ...(options.checkpointEveryEvents === undefined
      ? {}
      : { checkpointEveryEvents: options.checkpointEveryEvents }),
  });
  const execution = { runId, checkpointer, budgetTracker };
  return runLoopSteps(options, events, execution);
}

async function recordBudgetFailure(
  recorder: RunRecorder,
  events: Event[],
  violation: BudgetViolation,
): Promise<Event> {
  const recorded = await recorder.recordBatch([
    {
      type: "budget_exceeded",
      v: 1,
      budget: violation.budget,
      limit: violation.limit,
      observed: violation.observed,
    },
    {
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "failed",
      reason: "budget_exceeded",
    },
  ]);
  events.push(...recorded);
  const failed = recorded.at(-1);
  if (failed === undefined) {
    throw new Error("Expected budget failure events.");
  }
  return failed;
}

/**
 * Records a budget failure and writes a checkpoint when the configured cadence requires one.
 *
 * @param recorder - Recorder for the active run segment.
 * @param events - Complete event history, extended with the failure and optional checkpoint.
 * @param violation - Budget limit exceeded by the folded run state.
 * @param checkpointer - Checkpointer associated with the active run.
 * @returns The run-status event that marks the run failed.
 */
export async function recordBudgetFailureAndCheckpoint(
  recorder: RunRecorder,
  events: Event[],
  violation: BudgetViolation,
  checkpointer: Checkpointer,
): Promise<Event> {
  const failed = await recordBudgetFailure(recorder, events, violation);
  await checkpointAfterStep(checkpointer, events);
  return failed;
}

async function runLoopSteps(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
): Promise<Event> {
  for (;;) {
    if (options.signal.aborted) {
      throw new RunAbortedError();
    }
    const context = await options.context.build(events.slice());
    const currentState = foldRunState(events);
    const modelBudget = execution.budgetTracker.check(
      { ...currentState, steps: currentState.steps + 1 },
      options.clock.now(),
    );
    if (!modelBudget.ok) {
      return recordBudgetFailureAndCheckpoint(
        options.recorder,
        events,
        modelBudget,
        execution.checkpointer,
      );
    }
    const modelResult = await modelStep({
      recorder: options.recorder,
      model: options.model,
      ids: options.ids,
      runId: execution.runId,
      messages: { goal: options.goal, context },
      signal: options.signal,
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.modelName === undefined ? {} : { modelName: options.modelName }),
    });
    events.push(...modelResult.events);
    const stepState = await checkpointAfterStep(execution.checkpointer, events);
    if (stepState.status === "suspended") {
      return suspendedOutcome(events);
    }

    if (modelResult.outcome === "failed") {
      const failedEvent = modelResult.events.at(-1);
      if (failedEvent === undefined) {
        throw new Error("Expected the model step to record a failure.");
      }
      return failedEvent;
    }

    if (modelResult.completion.toolCalls.length > 0) {
      const outcome = await runToolCalls(
        options,
        events,
        execution,
        modelResult.completion.toolCalls,
      );
      if (outcome !== undefined) {
        return outcome;
      }
      continue;
    }

    const finished = await options.recorder.record({
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "completed",
      reason: "final_answer",
    });
    events.push(finished);
    await checkpointAfterStep(execution.checkpointer, events);
    return finished;
  }
}

async function runToolCalls(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
  calls: ModelCompletion["toolCalls"],
): Promise<Event | undefined> {
  for (const call of calls) {
    const budget = execution.budgetTracker.check(foldRunState(events), options.clock.now());
    if (!budget.ok) {
      return recordBudgetFailureAndCheckpoint(
        options.recorder,
        events,
        budget,
        execution.checkpointer,
      );
    }
    events.push(
      ...(await toolStep({
        recorder: options.recorder,
        tool: options.tool,
        clock: options.clock,
        runId: execution.runId,
        calls: [call],
        signal: options.signal,
      })),
    );
    const state = await checkpointAfterStep(execution.checkpointer, events);
    if (state.status === "suspended") {
      return suspendedOutcome(events);
    }
  }
  return undefined;
}

async function checkpointAfterStep(checkpointer: Checkpointer, events: Event[]): Promise<RunState> {
  const state = foldRunState(events);
  const checkpoint = await checkpointer.maybeCheckpoint(state);
  if (checkpoint !== undefined) {
    events.push(checkpoint);
    return foldRunState(events);
  }
  return state;
}

function suspendedOutcome(events: readonly Event[]): Event {
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.type === "run_status_changed" && candidate.to === "suspended");
  if (event === undefined) {
    throw new Error("Expected a suspension status event.");
  }
  return event;
}
