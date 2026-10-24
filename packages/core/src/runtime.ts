// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Id } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import { forceFlushTelemetry, sentinelTripQueue } from "@rovinos/telemetry";
import {
  assertRuntimeOwnership,
  closeRuntimeResources,
  markTerminalBestEffort,
  recoverRunControlError,
  withSandboxLease,
  readRuntimeControlResult,
} from "./runtime-lifecycle.js";
import { composeAbortSignals, watchCancellation } from "./runtime-cancellation.js";
import { cancelRun } from "./cancel.js";
import { resolveApproval as resolveApprovalEvent } from "./approvals.js";
import { withResumeWakeUp } from "./runtime-approval-wake.js";
import type { ToolPort } from "./ports.js";
import type { Clock } from "./recorder.js";
import { resumeRun } from "./resume.js";
import { inheritedBudgets } from "./continue.js";
import { installShutdownHandler, type ShutdownProcessLike } from "./shutdown.js";
import type { RunLoopResult } from "./loop.js";
import type { RoleRegistry } from "./roles.js";
import type { RunScopeRegistry } from "./subagent/scope.js";
import { createRuntimeToolPort } from "./runtime-tool-composition.js";
import {
  createRuntimeContinuation,
  readChildBudgetAllocation,
  readStoredQuotaIdentity,
  readStoredGoal,
  readContinuationHistory,
  startRun,
  type RunControl,
} from "./runtime-runs.js";
import { QuotaService } from "./quotas.js";
import { setupRuntime } from "./runtime-setup.js";
import { createRuntimeAppCallbacks, hostedAppContentTokenizer } from "./runtime-apps.js";
import { appendFinalRunTrips, flushAndDrainTrips } from "./runtime-sentinel-trips.js";
import type {
  Runtime,
  RuntimeComposition,
  RuntimeConfig,
  RuntimeResumeOptions,
  RuntimeOverrides,
} from "./runtime-config.js";
export type {
  Runtime,
  RuntimeConfig,
  RuntimeOverrides,
  RuntimeResumeOptions,
  RuntimeRunHandle,
} from "./runtime-config.js";

class RunInputMissingError extends HarnessError {
  readonly code = "run_input_missing";

  constructor() {
    super("The run input is unavailable.");
  }
}

class ApprovalEditUnavailableError extends HarnessError {
  readonly code = "approval_edit_unavailable";

  constructor() {
    super("approval_edit_unavailable");
  }
}

class AlreadyTokenizedRequiresReplayPortsError extends HarnessError {
  readonly code = "already_tokenized_requires_replay_ports";

  constructor() {
    super("alreadyTokenized is only available with isolated replay ports.");
  }
}

const defaultProcessLike: ShutdownProcessLike = {
  on: (signal, listener) => process.on(signal, listener),
  removeListener: (signal, listener) => process.removeListener(signal, listener),
  get exitCode(): number | undefined {
    return typeof process.exitCode === "number" ? process.exitCode : undefined;
  },
  set exitCode(code) {
    if (code !== undefined) {
      process.exitCode = code;
    }
  },
  // The shutdown grace deadline must force termination if the active operation does not flush.
  // eslint-disable-next-line n/no-process-exit -- shutdown deadline is the final safety bound
  exit: (code) => process.exit(code),
};

interface RunControlOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly firstNewSeq: number;
  readonly clock: Clock;
  readonly flushTelemetry?: RuntimeOverrides["flushTelemetry"];
  readonly processLike: ShutdownProcessLike;
  readonly graceMs: number;
  readonly operation: (signal: AbortSignal) => Promise<RunLoopResult>;
  readonly ownershipSignal?: AbortSignal;
}

async function withRunControl(options: RunControlOptions): Promise<RunLoopResult> {
  sentinelTripQueue.beginRun(options.runId);
  const controller = new AbortController();
  const stopWatcher = new AbortController();
  const cursor = { nextSeq: options.firstNewSeq };
  const cancellation = { observed: false };
  let running: Promise<RunLoopResult> | undefined;
  let result: RunLoopResult | undefined;
  let tripsFinalized = false;
  const uninstall = installShutdownHandler({
    processLike: options.processLike,
    controller,
    graceMs: options.graceMs,
    onTimeout: async () => {
      await running;
    },
  });
  const operationSignal =
    options.ownershipSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.ownershipSignal]);
  const watcher = watchCancellation({
    store: options.store,
    runId: options.runId,
    firstSeq: options.firstNewSeq,
    controller,
    stopSignal: stopWatcher.signal,
    onCursor: (nextSeq) => {
      cursor.nextSeq = nextSeq;
    },
    onCancellation: () => {
      cancellation.observed = true;
    },
  });

  try {
    assertRuntimeOwnership(options.ownershipSignal);
    running = options.operation(operationSignal);
    try {
      result = await running;
      assertRuntimeOwnership(options.ownershipSignal);
    } catch (error) {
      const recovery = await recoverRunControlError({
        error,
        store: options.store,
        runId: options.runId,
        firstNewSeq: options.firstNewSeq,
        nextSeq: cursor.nextSeq,
        cancellationObserved: cancellation.observed,
        controller,
        ...(options.ownershipSignal === undefined
          ? {}
          : { ownershipSignal: options.ownershipSignal }),
      });
      cancellation.observed = recovery.cancellationObserved;
      if (recovery.result === undefined) {
        throw error;
      }
      result = recovery.result;
    }
    if (cancellation.observed) {
      result = (await readRuntimeControlResult(options, "cancelled")) ?? result;
    }
    result = await appendFinalRunTrips(result, options);
    tripsFinalized = true;
    return result;
  } finally {
    stopWatcher.abort();
    uninstall();
    await watcher;
    if (running !== undefined && !tripsFinalized) {
      await flushAndDrainTrips(options);
    }
  }
}

function createTerminalAwareRunControl({
  config,
  overrides,
  clock,
  store,
  vault,
  sandboxBackend,
  instanceHeartbeat,
}: RuntimeComposition): RunControl {
  const flushTelemetry = overrides.flushTelemetry ?? forceFlushTelemetry;
  return async (runId, operation, firstNewSeq = 0) => {
    const result = await withSandboxLease(sandboxBackend, runId, () =>
      withRunControl({
        store,
        runId,
        firstNewSeq,
        clock,
        flushTelemetry,
        processLike: overrides.processLike ?? defaultProcessLike,
        graceMs: config.run.shutdownGraceMs,
        ...(instanceHeartbeat === undefined ? {} : { ownershipSignal: instanceHeartbeat.signal }),
        operation,
      }),
    );
    if (
      result.status === "completed" ||
      result.status === "failed" ||
      result.status === "cancelled"
    ) {
      await markTerminalBestEffort(vault, runId, clock.now());
    }
    return result;
  };
}

function createRuntimeRunMethods(
  options: RuntimeComposition,
  tool: ToolPort,
  runWithControl: RunControl,
): Pick<Runtime, "run" | "start"> {
  return {
    run: (goal, runOptions) => startRun(options, tool, goal, { runWithControl, ...runOptions }),
    start: (goal, runOptions) => {
      const runId = runOptions?.runId ?? options.ids.next();
      let resolveStarted: () => void = () => undefined;
      let rejectStarted: (reason?: unknown) => void = () => undefined;
      const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      void started.catch(() => undefined);
      const completion = startRun(options, tool, goal, {
        runWithControl,
        ...runOptions,
        runId,
        onStarted: resolveStarted,
      });
      void completion.catch(rejectStarted);
      return {
        runId,
        started,
        completion,
      };
    },
  };
}

function composeRuntime(
  options: RuntimeComposition & {
    readonly roles: RoleRegistry;
    readonly scopes: RunScopeRegistry;
  },
): Runtime {
  const { config, clock, ids, store, keys, vault, vaultResolver, scopes } = options;
  const tool = createRuntimeToolPort(options);
  const runWithControl = createTerminalAwareRunControl(options);
  const resume = createRuntimeResume(options, tool, runWithControl);
  const pii = options.pii;
  const appCallbacks = createRuntimeAppCallbacks({
    store,
    clock,
    ...(options.instanceHeartbeat === undefined
      ? {}
      : { ownershipSignal: options.instanceHeartbeat.signal }),
    approval: { tool, policy: options.policy, context: options.context, ids },
    ...(pii === undefined ? {} : { tokenize: hostedAppContentTokenizer(pii.tokenizer) }),
  });
  return {
    store,
    ...(options.overrides.queue === undefined ? {} : { queue: options.overrides.queue }),
    vault: vaultResolver,
    keys,
    sandboxBackend: options.sandboxBackend,
    clock,
    ids,
    ...createRuntimeRunMethods(options, tool, runWithControl),
    continueRun: createRuntimeContinuation(options, tool, scopes, runWithControl),
    resume,
    cancel: async (runId) => {
      assertRuntimeOwnership(options.instanceHeartbeat?.signal);
      const result = await cancelRun(store, runId, clock, ids);
      if (result === "cancelled") {
        await markTerminalBestEffort(vault, runId, clock.now());
      }
      return result;
    },
    ...appCallbacks,
    onAppContent: (content) => {
      assertRuntimeOwnership(options.instanceHeartbeat?.signal);
      return appCallbacks.onAppContent(content);
    },
    resolveApproval: async (runId, approvalId, decision, resolveOptions) => {
      assertRuntimeOwnership(options.instanceHeartbeat?.signal);
      if (
        decision === "edit" &&
        options.overrides.tool === undefined &&
        (config.servers?.length ?? 0) === 0
      ) {
        throw new ApprovalEditUnavailableError();
      }
      return withResumeWakeUp(options.overrides.queue, config.run.autoResume, runId, () =>
        resolveApprovalEvent(
          store,
          runId,
          approvalId,
          decision,
          resolveOptions?.edits,
          clock,
          tool,
          resolveOptions?.metadata,
        ),
      );
    },
    close: () =>
      closeRuntimeResources({
        store,
        ...(options.closeToolPort === undefined ? {} : { closeToolPort: options.closeToolPort }),
        vault,
        keys,
        sandboxBackend: options.sandboxBackend,
        instanceHeartbeat: options.instanceHeartbeat,
        flushTelemetry: options.overrides.flushTelemetry ?? forceFlushTelemetry,
      }),
  };
}

function createRuntimeResume(
  options: RuntimeComposition & { readonly scopes: RunScopeRegistry },
  tool: ToolPort,
  runWithControl: RunControl,
): Runtime["resume"] {
  const { config, clock, ids, store, model, context, policy, scopes } = options;
  const quotaService = new QuotaService(config.quotas ?? [], store, clock);
  return async (runId, resumeOptions: RuntimeResumeOptions = {}) => {
    const firstNewSeq = await store.head(runId);
    const childAllocation = await readChildBudgetAllocation(store, runId);
    const previousEventLogs = await readContinuationHistory(
      store,
      runId,
      config.run.continuations.maxChainLength,
    );
    const budgets =
      childAllocation?.budgets ??
      (previousEventLogs !== undefined && config.run.continuations.inheritBudgets
        ? inheritedBudgets(config.run.budgets, previousEventLogs)
        : config.run.budgets);
    return runWithControl(
      runId,
      async (signal) => {
        const goal = await readStoredGoal(store, runId);
        if (goal === undefined) {
          throw new RunInputMissingError();
        }
        const quotaIdentity = await readStoredQuotaIdentity(store, runId);
        const composed = composeAbortSignals([
          signal,
          ...(resumeOptions.signal === undefined ? [] : [resumeOptions.signal]),
        ]);
        try {
          return await resumeRun({
            store,
            runId,
            clock,
            ids,
            goal,
            model,
            tool,
            policy,
            context,
            signal: composed.signal,
            scopes,
            budgets,
            ...(previousEventLogs === undefined ? {} : { previousEventLogs }),
            ...(childAllocation === undefined ? {} : { deadlineTs: childAllocation.deadlineTs }),
            checkpointEveryEvents: config.run.checkpointEveryEvents,
            ...(config.store?.snapshotKeep === undefined
              ? {}
              : { snapshotKeep: config.store.snapshotKeep }),
            resumePolicy: config.run.resume.onNonIdempotent,
            ...(config.sandbox?.restoreOnResume === undefined
              ? {}
              : { restoreOnResume: config.sandbox.restoreOnResume }),
            workspaceSnapshotter: options.workspaceSnapshotter,
            quotaService,
            quotaIdentity,
            ...(resumeOptions.onClaimed === undefined
              ? {}
              : { onClaimed: resumeOptions.onClaimed }),
          });
        } finally {
          composed.dispose();
        }
      },
      firstNewSeq,
    );
  };
}

/**
 * Builds a runtime from validated config with injectable ports.
 * Supply tools in decorator order `Offloading(Pii(Policy(Tools)))`; the loop
 * evaluates policy after preparation so it only sees tokenized arguments.
 * Binary results use the outer offloader and are never returned as previews.
 *
 * @param config - Validated run and model configuration.
 * @param overrides - Optional stores, ports, and deterministic test dependencies.
 * @returns Shared run, resume, cancellation, and store operations.
 */
export async function createRuntime(
  config: RuntimeConfig,
  overrides: RuntimeOverrides = {},
): Promise<Runtime> {
  if (
    overrides.alreadyTokenized === true &&
    (overrides.transientVault !== true ||
      overrides.store === undefined ||
      overrides.model === undefined ||
      overrides.tool === undefined)
  ) {
    throw new AlreadyTokenizedRequiresReplayPortsError();
  }
  return composeRuntime(await setupRuntime(config, overrides));
}
