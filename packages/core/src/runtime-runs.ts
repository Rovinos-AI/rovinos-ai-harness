// SPDX-License-Identifier: Apache-2.0
import {
  type Code,
  type Id,
  type JsonValue,
  type RunConfig,
  type RunInput,
  type Principal,
} from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { RunScopeRegistry } from "./subagent/scope.js";
import type { ToolPort } from "./ports.js";
import { continueRun as startContinuation } from "./continue.js";
import { runLoop, type RunLoopResult } from "./loop.js";
import { RunRecorder } from "./recorder.js";
import type { Runtime, RuntimeComposition, RuntimeRunHandle } from "./runtime-config.js";
import { configHash } from "./runtime-ids.js";

/** Reads the original goal from a run's persisted input or first model request. */
export async function readStoredGoal(store: EventStore, runId: Id): Promise<JsonValue | undefined> {
  for await (const event of store.read(runId)) {
    if (event.type === "run_input") {
      return event.input;
    }
    if (event.type === "model_request") {
      const goalMessage = event.messages.find(({ role }) => role === "user");
      const goalPart = goalMessage?.parts.find((part) => part.type === "text");
      if (goalPart?.type === "text") {
        return goalPart.text;
      }
    }
  }
  return undefined;
}

/** Recovers an inherited child allocation so runtime recreation cannot widen its limits. */
export async function readChildBudgetAllocation(
  store: EventStore,
  runId: Id,
): Promise<{ readonly budgets: RunConfig["budgets"]; readonly deadlineTs: number } | undefined> {
  let parentRunId: Id | undefined;
  for await (const event of store.read(runId)) {
    if (event.type === "run_created") {
      parentRunId = event.parentRunId;
      break;
    }
  }
  if (parentRunId === undefined) {
    return undefined;
  }
  for await (const event of store.read(parentRunId)) {
    if (
      event.type === "subagent_spawned" &&
      event.childRunId === runId &&
      event.budgetLimits !== undefined &&
      event.budgetDeadlineTs !== undefined
    ) {
      return {
        budgets: event.budgetLimits,
        deadlineTs: event.budgetDeadlineTs,
      };
    }
  }
  return undefined;
}

/** Executes a run while applying cancellation and shutdown control. */
export type RunControl = (
  runId: Id,
  operation: (signal: AbortSignal) => Promise<RunLoopResult>,
  firstNewSeq?: number,
) => Promise<RunLoopResult>;

/** Optional id and role assigned to a new root run. */
export interface RuntimeRunOptions {
  readonly runId?: Id;
  readonly role?: Code;
  readonly requestedBy?: Principal;
  readonly onStarted?: () => void;
}

/** Runtime control and optional metadata used to start one run. */
export interface StartRunExecutionOptions extends RuntimeRunOptions {
  readonly runWithControl: RunControl;
}

/** Starts a root run through the runtime's cancellation-control boundary. */
export function startRun(
  composition: RuntimeComposition,
  tool: ToolPort,
  goal: JsonValue,
  options: StartRunExecutionOptions,
): Promise<RunLoopResult> {
  const { config, clock, ids, store, model, context, policy, policyVersion } = composition;
  const runId = options.runId ?? ids.next();
  return options.runWithControl(runId, (signal) => {
    const recorder = new RunRecorder(store, runId, ids.next(), 0, clock);
    return runLoop({
      recorder,
      clock,
      model,
      tool,
      policy,
      context,
      ids,
      goal,
      signal,
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.requestedBy === undefined ? {} : { requestedBy: options.requestedBy }),
      scopeId: runId,
      budgets: config.run.budgets,
      checkpointEveryEvents: config.run.checkpointEveryEvents,
      ...(config.store?.snapshotKeep === undefined
        ? {}
        : { snapshotKeep: config.store.snapshotKeep }),
      workspaceSnapshotter: composition.workspaceSnapshotter,
      configHash: configHash(config),
      policyVersion,
      ...(options.onStarted === undefined ? {} : { onStarted: options.onStarted }),
    });
  });
}

/** Creates the runtime method that starts linked continuation runs. */
export function createRuntimeContinuation(
  composition: RuntimeComposition,
  tool: ToolPort,
  scopes: RunScopeRegistry,
  runWithControl: RunControl,
): Runtime["continueRun"] {
  const { config, clock, ids, store, model, context, policy, policyVersion } = composition;
  return (
    previousRunId: Id,
    input: RunInput,
    runOptions?: { readonly requestedBy?: Principal },
  ) => {
    const runId = ids.next();
    let resolveStarted: () => void = () => undefined;
    let rejectStarted: (reason?: unknown) => void = () => undefined;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    void started.catch(() => undefined);
    const goal =
      input.metadata === undefined
        ? { goal: input.goal }
        : { goal: input.goal, metadata: input.metadata };
    const completion = runWithControl(runId, (signal) =>
      startContinuation({
        store,
        runId,
        previousRunId,
        goal,
        clock,
        ids,
        model,
        tool,
        policy,
        context,
        signal,
        budgets: config.run.budgets,
        checkpointEveryEvents: config.run.checkpointEveryEvents,
        ...(config.store?.snapshotKeep === undefined
          ? {}
          : { snapshotKeep: config.store.snapshotKeep }),
        workspaceSnapshotter: composition.workspaceSnapshotter,
        configHash: configHash(config),
        policyVersion,
        continuations: config.run.continuations,
        scopes,
        onStarted: resolveStarted,
        ...(runOptions?.requestedBy === undefined ? {} : { requestedBy: runOptions.requestedBy }),
      }),
    );
    void completion.catch(rejectStarted);
    return { runId, started, completion } satisfies RuntimeRunHandle;
  };
}
