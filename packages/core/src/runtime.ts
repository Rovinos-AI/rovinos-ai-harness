// SPDX-License-Identifier: Apache-2.0
import { diag } from "@opentelemetry/api";
import { HarnessError, type Event, type Id, type JsonValue } from "@harness/schemas";
import { PiiToolPort } from "@harness/pii";
import { type EventStore } from "@harness/store";
import { cancelRun } from "./cancel.js";
import type { ToolPort } from "./ports.js";
import { LeaseLostError, type Clock } from "./recorder.js";
import { resumeRun } from "./resume.js";
import { installShutdownHandler, type ShutdownProcessLike } from "./shutdown.js";
import type { RunLoopResult } from "./loop.js";
import type { RoleRegistry } from "./roles.js";
import { foldRunState } from "./run-state.js";
import type { RunScopeRegistry } from "./subagent/scope.js";
import { createSubagentTool } from "./subagent/runtime.js";
import { createRuntimeContinuation, startRun, type RunControl } from "./runtime-runs.js";
import { setupRuntime } from "./runtime-setup.js";
import { appendFinalRunTrips, flushAndDrainTrips } from "./runtime-sentinel-trips.js";
import type {
  Runtime,
  RuntimeComposition,
  RuntimeConfig,
  RuntimeOverrides,
} from "./runtime-config.js";
const CANCEL_REQUESTED = "cancel_requested";
const CANCEL_MONITOR_DEGRADED = "cancel_monitor_degraded";
const CANCEL_POLL_INTERVAL_MS = 25;
const CANCEL_POLL_MAX_INTERVAL_MS = 5_000;
const cancellationMonitorLogger = diag.createComponentLogger({ namespace: "harness.core" });
// TODO(7.14): Replace polling with the live EventStore.watch() subscription.

export type { Runtime, RuntimeConfig, RuntimeOverrides } from "./runtime-config.js";

class RunInputMissingError extends HarnessError {
  readonly code = "run_input_missing";

  constructor() {
    super("The run input is unavailable.");
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

async function readEvents(store: EventStore, runId: Id, fromSeq = 0): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId, { fromSeq })) {
    events.push(event);
  }
  return events;
}

async function inspectTail(store: EventStore, runId: Id, fromSeq: number): Promise<Event[]> {
  return readEvents(store, runId, fromSeq);
}

async function cancelledResult(
  store: EventStore,
  runId: Id,
  firstNewSeq: number,
): Promise<RunLoopResult | undefined> {
  const events = await readEvents(store, runId);
  const state = foldRunState(events);
  if (state.status !== "cancelled") {
    return undefined;
  }
  return {
    status: state.status,
    approvalIds: Array.from(state.pendingApprovals.keys()),
    state,
    events: events.filter((event) => event.seq >= firstNewSeq),
  };
}

function waitForWatcher(signal: AbortSignal, delayMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(!signal.aborted);
    }, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
}

interface CancellationTailOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly fromSeq: number;
  readonly controller: AbortController;
  readonly onCursor: (nextSeq: number) => void;
  readonly onCancellation: () => void;
}

async function inspectCancellationTail(options: CancellationTailOptions): Promise<boolean> {
  for (const event of await inspectTail(options.store, options.runId, options.fromSeq)) {
    options.onCursor(event.seq + 1);
    if (event.type === "run_status_changed" && event.to === "cancelled") {
      options.onCancellation();
      options.controller.abort(CANCEL_REQUESTED);
      return true;
    }
  }
  return false;
}

interface CancellationWatchOptions extends Omit<CancellationTailOptions, "fromSeq"> {
  readonly firstSeq: number;
  readonly stopSignal: AbortSignal;
}

async function watchCancellation(options: CancellationWatchOptions): Promise<void> {
  let nextSeq = options.firstSeq;
  let delayMs = CANCEL_POLL_INTERVAL_MS;
  while (!options.stopSignal.aborted) {
    if (!(await waitForWatcher(options.stopSignal, delayMs))) {
      return;
    }
    try {
      const cancelled = await inspectCancellationTail({
        ...options,
        fromSeq: nextSeq,
        onCursor: (value) => {
          nextSeq = value;
          options.onCursor(value);
        },
      });
      delayMs = CANCEL_POLL_INTERVAL_MS;
      if (cancelled) {
        return;
      }
    } catch {
      try {
        cancellationMonitorLogger.warn(CANCEL_MONITOR_DEGRADED);
      } catch {
        // A diagnostic logger failure must not disable cooperative cancellation.
      }
      delayMs = Math.min(delayMs * 2, CANCEL_POLL_MAX_INTERVAL_MS);
    }
  }
}

interface RunControlOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly firstNewSeq: number;
  readonly clock: Clock;
  readonly flushTelemetry?: RuntimeOverrides["flushTelemetry"];
  readonly processLike: ShutdownProcessLike;
  readonly graceMs: number;
  readonly operation: (signal: AbortSignal) => Promise<RunLoopResult>;
}

async function withRunControl(options: RunControlOptions): Promise<RunLoopResult> {
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
    running = options.operation(controller.signal);
    try {
      result = await running;
    } catch (error) {
      if (error instanceof LeaseLostError) {
        await inspectCancellationTail({
          store: options.store,
          runId: options.runId,
          fromSeq: cursor.nextSeq,
          controller,
          onCursor: (nextSeq) => {
            cursor.nextSeq = nextSeq;
          },
          onCancellation: () => {
            cancellation.observed = true;
          },
        });
      }
      if (cancellation.observed) {
        const cancelled = await cancelledResult(options.store, options.runId, options.firstNewSeq);
        if (cancelled !== undefined) {
          result = cancelled;
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
    if (cancellation.observed) {
      result = (await cancelledResult(options.store, options.runId, options.firstNewSeq)) ?? result;
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

async function storedGoal(store: EventStore, runId: Id): Promise<JsonValue | undefined> {
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

async function closeRuntimeResources(options: {
  readonly store: EventStore;
  readonly vault: RuntimeComposition["vault"];
  readonly keys: RuntimeComposition["keys"];
  readonly flushTelemetry?: RuntimeOverrides["flushTelemetry"];
}): Promise<void> {
  try {
    await options.flushTelemetry?.();
  } finally {
    try {
      await options.store.close();
    } finally {
      try {
        options.vault.close();
      } finally {
        options.keys.dispose();
      }
    }
  }
}

function composeRuntime(
  options: RuntimeComposition & {
    readonly roles: RoleRegistry;
    readonly scopes: RunScopeRegistry;
  },
): Runtime {
  const {
    config,
    overrides,
    clock,
    ids,
    store,
    keys,
    vault,
    vaultResolver,
    pii,
    model,
    policy,
    policyVersion,
    roles,
    scopes,
  } = options;
  const subagentTool = createSubagentTool({
    config,
    clock,
    ids,
    store,
    model,
    parentTool: options.tool,
    policy,
    policyVersion,
    roles,
    scopes,
  });
  const tool =
    pii === undefined
      ? subagentTool
      : new PiiToolPort(subagentTool, {
          tokenizer: pii.tokenizer,
          config: pii.config,
          resolver: pii.resolver,
        });
  const runWithControl: RunControl = (runId, operation) =>
    withRunControl({
      store,
      runId,
      firstNewSeq: 0,
      clock,
      ...(overrides.flushTelemetry === undefined
        ? {}
        : { flushTelemetry: overrides.flushTelemetry }),
      processLike: overrides.processLike ?? defaultProcessLike,
      graceMs: config.run.shutdownGraceMs,
      operation,
    });
  const resume = createRuntimeResume(options, tool);
  return {
    store,
    vault: vaultResolver,
    keys,
    clock,
    ids,
    run: (goal) => startRun(options, tool, goal, runWithControl),
    continueRun: createRuntimeContinuation(options, tool, scopes, runWithControl),
    resume,
    cancel: (runId) => cancelRun(store, runId, clock, ids),
    close: () =>
      closeRuntimeResources({
        store,
        vault,
        keys,
        ...(overrides.flushTelemetry === undefined
          ? {}
          : { flushTelemetry: overrides.flushTelemetry }),
      }),
  };
}

function createRuntimeResume(
  options: RuntimeComposition & { readonly scopes: RunScopeRegistry },
  tool: ToolPort,
): Runtime["resume"] {
  const { config, clock, ids, store, model, context, policy, scopes, overrides } = options;
  return async (runId) => {
    const firstNewSeq = await store.head(runId);
    return withRunControl({
      store,
      runId,
      firstNewSeq,
      clock,
      ...(overrides.flushTelemetry === undefined
        ? {}
        : { flushTelemetry: overrides.flushTelemetry }),
      processLike: overrides.processLike ?? defaultProcessLike,
      graceMs: config.run.shutdownGraceMs,
      operation: async (signal) => {
        const goal = await storedGoal(store, runId);
        if (goal === undefined) {
          throw new RunInputMissingError();
        }
        return resumeRun({
          store,
          runId,
          clock,
          ids,
          goal,
          model,
          tool,
          policy,
          context,
          signal,
          scopes,
          budgets: config.run.budgets,
          checkpointEveryEvents: config.run.checkpointEveryEvents,
          resumePolicy: config.run.resume.onNonIdempotent,
        });
      },
    });
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
  return composeRuntime(await setupRuntime(config, overrides));
}
