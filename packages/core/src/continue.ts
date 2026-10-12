// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  type Event,
  type Id,
  type JsonValue,
  type RunConfig,
} from "@harness/schemas";
import type { Link } from "@opentelemetry/api";
import type { EventStore } from "@harness/store";
import { CorruptLogError, foldRunState } from "./run-state.js";
import { RunRecorder } from "./recorder.js";
import { runLoop, type RunLoopOptions, type RunLoopResult } from "./loop.js";
import type { RunScopeRegistry } from "./subagent/scope.js";

/** Error raised when a run is not eligible for continuation. */
export class RunNotTerminalError extends HarnessError {
  readonly code = "run_not_terminal";

  constructor() {
    super("Only eligible terminal runs can be continued.");
  }
}

/** Error raised when a continuation would exceed the configured lineage limit. */
export class ContinuationChainTooLongError extends HarnessError {
  readonly code = "continuation_chain_too_long";

  constructor() {
    super("The continuation chain exceeds its configured maximum length.");
  }
}

class RunNotFoundError extends HarnessError {
  readonly code = "run_not_found";

  constructor() {
    super("The run was not found.");
  }
}

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

function createdEvent(events: readonly Event[]): Extract<Event, { type: "run_created" }> {
  const created = events[0];
  if (events.length === 0) {
    throw new RunNotFoundError();
  }
  if (created?.type !== "run_created") {
    throw new CorruptLogError();
  }
  return created;
}

/** Loads a run and its ancestors in chronological order, bounded by the configured chain limit. */
export async function loadContinuationChain(
  store: EventStore,
  runId: Id,
  maxChainLength: number,
): Promise<Event[][]> {
  const newestFirst: Event[][] = [];
  const visited = new Set<Id>();
  let current: Id | undefined = runId;
  while (current !== undefined) {
    if (visited.has(current)) {
      throw new CorruptLogError();
    }
    if (newestFirst.length >= maxChainLength) {
      throw new ContinuationChainTooLongError();
    }
    visited.add(current);
    const events = await readEvents(store, current);
    const created = createdEvent(events);
    foldRunState(events);
    newestFirst.push(events);
    current = created.continuationOf;
  }
  return newestFirst.reverse();
}

interface ScopeRestoreOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly events: readonly Event[];
  readonly scopes: RunScopeRegistry;
  readonly visited?: Set<Id>;
}

async function registerRunScope(options: ScopeRestoreOptions): Promise<void> {
  const { store, runId, events, scopes } = options;
  const visited = options.visited ?? new Set<Id>();
  const created = createdEvent(events);
  if (created.scopeId !== undefined) {
    scopes.register(runId, created.scopeId);
    return;
  }
  if (visited.has(runId)) {
    throw new CorruptLogError();
  }
  visited.add(runId);
  const parentRunId = created.parentRunId ?? created.continuationOf;
  if (parentRunId === undefined) {
    scopes.register(runId, runId);
    return;
  }
  const parentEvents = await readEvents(store, parentRunId);
  await registerRunScope({
    store,
    runId: parentRunId,
    events: parentEvents,
    scopes,
    visited,
  });
  scopes.register(runId, scopes.scopeOf(parentRunId));
}

function linkedRoot(events: readonly Event[]): Link {
  const root = createdEvent(events);
  return {
    context: {
      traceId: root.traceId,
      spanId: root.spanId,
      traceFlags: 1,
      isRemote: true,
    },
  };
}

/** Subtracts completed ancestor usage from the limits for a continuation run. */
export function inheritedBudgets(
  budgets: RunConfig["budgets"],
  previousLogs: readonly (readonly Event[])[],
): RunConfig["budgets"] {
  const states = previousLogs.map((events) => foldRunState(events));
  const spentSteps = states.reduce((total, state) => total + state.steps, 0);
  const spentCostMicros = states.reduce((total, state) => total + state.usage.costMicros, 0);
  const elapsedMs = states.reduce(
    (total, state) =>
      total +
      Math.max(
        0,
        state.lastTs - state.startedAt - (budgets.countSuspendedTime ? 0 : state.suspendedTimeMs),
      ),
    0,
  );
  return {
    ...budgets,
    maxSteps: budgets.maxSteps - spentSteps,
    maxWallClockMs: budgets.maxWallClockMs - elapsedMs,
    ...(budgets.maxCostUsd === undefined
      ? {}
      : { maxCostUsd: budgets.maxCostUsd - spentCostMicros / 1_000_000 }),
  };
}

/** Inputs needed to execute a follow-up as an independent run linked to a terminal run. */
export interface ContinueRunOptions extends Omit<
  RunLoopOptions,
  | "recorder"
  | "goal"
  | "scopeId"
  | "continuationOf"
  | "inputKind"
  | "previousEventLogs"
  | "parentRunId"
  | "parentCallId"
  | "depth"
  | "rootSpanParent"
  | "rootSpanLinks"
> {
  readonly store: EventStore;
  readonly runId: Id;
  readonly previousRunId: Id;
  readonly goal: JsonValue;
  readonly continuations: RunConfig["continuations"];
  readonly scopes: RunScopeRegistry;
}

/**
 * Creates a new run from a completed conversation without appending to the source log.
 *
 * @param options - Store, source run, follow-up input, runtime ports, and continuation policy.
 * @returns The new run's final state and events.
 * @throws RunNotTerminalError when the source run is not eligible for continuation.
 * @throws ContinuationChainTooLongError when the configured chain limit would be exceeded.
 */
export async function continueRun(options: ContinueRunOptions): Promise<RunLoopResult> {
  const { store, runId, previousRunId, goal, continuations, scopes, ...runOptions } = options;
  const previousLogs = await loadContinuationChain(
    store,
    previousRunId,
    continuations.maxChainLength,
  );
  if (previousLogs.length >= continuations.maxChainLength) {
    throw new ContinuationChainTooLongError();
  }

  const previousEvents = previousLogs.at(-1);
  if (previousEvents === undefined) {
    throw new RunNotFoundError();
  }
  const previousState = foldRunState(previousEvents);
  if (
    previousState.status !== "completed" &&
    !(continuations.allowFromFailed && previousState.status === "failed")
  ) {
    throw new RunNotTerminalError();
  }

  await registerRunScope({ store, runId: previousRunId, events: previousEvents, scopes });
  const scopeId = scopes.scopeOf(previousRunId);
  scopes.register(runId, scopeId);
  const budgets = continuations.inheritBudgets
    ? inheritedBudgets(runOptions.budgets, previousLogs)
    : runOptions.budgets;
  const recorder = new RunRecorder(store, runId, runOptions.ids.next(), 0, runOptions.clock);

  return runLoop({
    ...runOptions,
    recorder,
    goal,
    budgets,
    scopeId,
    continuationOf: previousRunId,
    inputKind: "follow_up",
    previousEventLogs: previousLogs,
    rootSpanLinks: [linkedRoot(previousEvents)],
  });
}
