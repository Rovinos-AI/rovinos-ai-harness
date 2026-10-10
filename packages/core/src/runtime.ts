// SPDX-License-Identifier: Apache-2.0
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { diag } from "@opentelemetry/api";
import { HarnessError, type Event, type Id, type JsonValue } from "@harness/schemas";
import { SqliteEventStore, type EventStore } from "@harness/store";
import { ensureTracingFallback } from "@harness/telemetry";
import { cancelRun } from "./cancel.js";
import { NaiveContext } from "./context/naive-context.js";
import type { ModelPort, ToolPort } from "./ports.js";
import { LeaseLostError, RunRecorder } from "./recorder.js";
import { resumeRun } from "./resume.js";
import { installShutdownHandler, type ShutdownProcessLike } from "./shutdown.js";
import { runLoop, type RunLoopResult } from "./loop.js";
import { createConfiguredModelPort } from "./runtime-model.js";
import { RUN_SPAN } from "./spans.js";
import { foldRunState } from "./run-state.js";
import { configHash, SystemIdGenerator, systemClock } from "./runtime-ids.js";
import type {
  Runtime,
  RuntimeComposition,
  RuntimeConfig,
  RuntimeOverrides,
} from "./runtime-config.js";
const POLICY_VERSION = "default";
const CANCEL_REQUESTED = "cancel_requested";
const CANCEL_MONITOR_DEGRADED = "cancel_monitor_degraded";
const CANCEL_POLL_INTERVAL_MS = 25;
const CANCEL_POLL_MAX_INTERVAL_MS = 5_000;
const cancellationMonitorLogger = diag.createComponentLogger({ namespace: "harness.core" });
// TODO(7.14): Replace polling with the live EventStore.watch() subscription.

export type { Runtime, RuntimeConfig, RuntimeOverrides } from "./runtime-config.js";

function ensureTracing(): void {
  const probeIds = new SystemIdGenerator(systemClock);
  const probe = RUN_SPAN.start({
    "harness.run.id": probeIds.next(),
    "harness.segment.id": probeIds.next(),
  });
  ensureTracingFallback(probe);
}

class ModelNotConfiguredError extends HarnessError {
  readonly code = "model_not_configured";

  constructor() {
    super("No model port is configured.");
  }
}

class ToolNotConfiguredError extends HarnessError {
  readonly code = "tool_not_configured";

  constructor() {
    super("No tool port is configured.");
  }
}

const missingModelPort: ModelPort = {
  complete: () => Promise.reject(new ModelNotConfiguredError()),
};

const unavailableTool: ToolPort = {
  describe: () => undefined,
  execute: () => Promise.reject(new ToolNotConfiguredError()),
};

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
    let result: RunLoopResult;
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
          return cancelled;
        }
      }
      throw error;
    }
    if (cancellation.observed) {
      return (await cancelledResult(options.store, options.runId, options.firstNewSeq)) ?? result;
    }
    return result;
  } finally {
    stopWatcher.abort();
    uninstall();
    await watcher;
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

async function createSqliteStore(dataDir: string, readOnly: boolean): Promise<EventStore> {
  if (!readOnly) {
    await mkdir(dataDir, { recursive: true });
  }
  return new SqliteEventStore(join(dataDir, "harness.db"), undefined, { readOnly });
}

function composeRuntime(options: RuntimeComposition): Runtime {
  const { config, overrides, clock, ids, store, model, tool, context } = options;
  return {
    store,
    clock,
    ids,
    run: (goal) => {
      const runId = ids.next();
      return withRunControl({
        store,
        runId,
        firstNewSeq: 0,
        processLike: overrides.processLike ?? defaultProcessLike,
        graceMs: config.run.shutdownGraceMs,
        operation: async (signal) => {
          const recorder = new RunRecorder(store, runId, ids.next(), 0, clock);
          return runLoop({
            recorder,
            clock,
            model,
            tool,
            context,
            ids,
            goal,
            signal,
            budgets: config.run.budgets,
            checkpointEveryEvents: config.run.checkpointEveryEvents,
            configHash: configHash(config),
            policyVersion: POLICY_VERSION,
          });
        },
      });
    },
    resume: async (runId) => {
      const firstNewSeq = await store.head(runId);
      return withRunControl({
        store,
        runId,
        firstNewSeq,
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
            context,
            signal,
            budgets: config.run.budgets,
            checkpointEveryEvents: config.run.checkpointEveryEvents,
            resumePolicy: config.run.resume.onNonIdempotent,
          });
        },
      });
    },
    cancel: (runId) => cancelRun(store, runId, clock, ids),
    close: () => store.close(),
  };
}

/**
 * Builds a runtime from validated config with injectable ports.
 * Supply a composed tool port: Offloading(Pii(Policy(Tools))); policy uses tokenized arguments.
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
  ensureTracing();
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? new SystemIdGenerator(clock);
  const model =
    overrides.model ??
    (await createConfiguredModelPort(config.models, {
      ids,
      clock,
      ...(overrides.providerAdapters === undefined
        ? {}
        : { providerAdapters: overrides.providerAdapters }),
      ...(overrides.secretResolver === undefined
        ? {}
        : { secretResolver: overrides.secretResolver }),
    })) ??
    missingModelPort;
  const dataDir = overrides.dataDir ?? process.env.HARNESS_DATA_DIR ?? process.cwd();
  const store =
    overrides.store ?? (await createSqliteStore(dataDir, overrides.readOnlyStore === true));
  const tool = overrides.tool ?? unavailableTool;
  const context = overrides.context ?? new NaiveContext();
  return composeRuntime({ config, overrides, clock, ids, store, model, tool, context });
}
