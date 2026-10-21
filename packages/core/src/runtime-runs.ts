// SPDX-License-Identifier: Apache-2.0
import {
  type Code,
  type Event,
  type Id,
  type JsonValue,
  type RunConfig,
  type RunInput,
  type Principal,
} from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { RunScopeRegistry } from "./subagent/scope.js";
import type { ToolPort } from "./ports.js";
import { continueRun as startContinuation, loadContinuationChain } from "./continue.js";
import { runLoop, type RunLoopResult } from "./loop.js";
import { RunRecorder } from "./recorder.js";
import type { Runtime, RuntimeComposition, RuntimeRunHandle } from "./runtime-config.js";
import { configHash } from "./runtime-ids.js";
import { QuotaService } from "./quotas.js";
import type { QuotaIdentity } from "./quotas.js";

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

/** Reads continuation ancestors for a queued continuation that has not started yet. */
export async function readContinuationHistory(
  store: EventStore,
  runId: Id,
  maxChainLength: number,
): Promise<Event[][] | undefined> {
  let continuation = false;
  for await (const event of store.read(runId)) {
    if (event.type === "run_created") {
      continuation = event.continuationOf !== undefined;
      break;
    }
  }
  if (!continuation) {
    return undefined;
  }
  const chain = await loadContinuationChain(store, runId, maxChainLength);
  return chain.slice(0, -1);
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
  const quotaService = new QuotaService(config.quotas ?? [], store, clock);
  const quotaIdentity: QuotaIdentity = {
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.requestedBy === undefined ? {} : { requestedBy: options.requestedBy }),
  };
  return options.runWithControl(runId, async (signal) => {
    await quotaService.assertCanStart(quotaIdentity);
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
      quotaService,
      quotaIdentity,
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
  const quotaService = new QuotaService(config.quotas ?? [], store, clock);
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
    const completion = runWithControl(runId, async (signal) => {
      const stored = await readStoredQuotaIdentity(store, previousRunId);
      // An explicit caller is charged for the continuation; the role is inherited.
      const identity: QuotaIdentity =
        runOptions?.requestedBy === undefined
          ? stored
          : { ...stored, requestedBy: runOptions.requestedBy };
      await quotaService.assertCanStart(identity);
      return startContinuation({
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
        quotaService,
        quotaIdentity: identity,
      });
    });
    void completion.catch(rejectStarted);
    return { runId, started, completion } satisfies RuntimeRunHandle;
  };
}

/** Reads only the stable principal and role codes needed to enforce inherited quotas. */
export async function readStoredQuotaIdentity(
  store: EventStore,
  runId: Id,
): Promise<QuotaIdentity> {
  let requestedBy: Principal | undefined;
  let role: Code | undefined;
  for await (const event of store.read(runId)) {
    if (event.type === "run_created" && event.requestedBy !== undefined) {
      requestedBy = event.requestedBy;
    }
    if (role === undefined && event.type === "run_created" && event.quotaRole !== undefined) {
      role = event.quotaRole;
    }
  }
  return {
    ...(requestedBy === undefined ? {} : { requestedBy }),
    ...(role === undefined ? {} : { role }),
  };
}
