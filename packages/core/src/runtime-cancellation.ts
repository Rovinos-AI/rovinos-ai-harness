// SPDX-License-Identifier: Apache-2.0
import { diag } from "@opentelemetry/api";
import type { Event, Id } from "@harness/schemas";
import type { EventStore } from "@harness/store";

const CANCEL_REQUESTED = "cancel_requested";
const CANCEL_MONITOR_DEGRADED = "cancel_monitor_degraded";
const CANCEL_POLL_INTERVAL_MS = 25;
const CANCEL_POLL_MAX_INTERVAL_MS = 5_000;
const cancellationMonitorLogger = diag.createComponentLogger({ namespace: "harness.core" });

/** Composes multiple cancellation sources and removes their listeners on disposal. */
export function composeAbortSignals(signals: readonly AbortSignal[]): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const listeners = signals.map((signal) => {
    const abort = (): void => {
      controller.abort(signal.reason);
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
    return { signal, abort };
  });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, abort } of listeners) {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

interface CancellationTailOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly fromSeq: number;
  readonly controller: AbortController;
  readonly onCursor: (nextSeq: number) => void;
  readonly onCancellation: () => void;
}

interface CancellationWatchOptions extends Omit<CancellationTailOptions, "fromSeq"> {
  readonly firstSeq: number;
  readonly stopSignal: AbortSignal;
}

async function readTail(store: EventStore, runId: Id, fromSeq: number): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId, { fromSeq })) {
    events.push(event);
  }
  return events;
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

/** Inspect stored cancellation events after a monitor read fails. */
export async function inspectCancellationTail(options: CancellationTailOptions): Promise<boolean> {
  for (const event of await readTail(options.store, options.runId, options.fromSeq)) {
    options.onCursor(event.seq + 1);
    if (event.type === "run_status_changed" && event.to === "cancelled") {
      options.onCancellation();
      options.controller.abort(CANCEL_REQUESTED);
      return true;
    }
  }
  return false;
}

/** Watch a run live, falling back to bounded polling if the subscription fails. */
export async function watchCancellation(options: CancellationWatchOptions): Promise<void> {
  let nextSeq = options.firstSeq;
  let watchFailed = false;
  try {
    for await (const event of options.store.watch(options.runId, {
      fromSeq: nextSeq,
      signal: options.stopSignal,
    })) {
      nextSeq = event.seq + 1;
      options.onCursor(nextSeq);
      if (event.type === "run_status_changed" && event.to === "cancelled") {
        options.onCancellation();
        options.controller.abort(CANCEL_REQUESTED);
        return;
      }
    }
  } catch {
    watchFailed = true;
    try {
      cancellationMonitorLogger.warn(CANCEL_MONITOR_DEGRADED);
    } catch {
      // A diagnostic logger failure must not disable cooperative cancellation.
    }
  }
  if (!watchFailed) {
    return;
  }
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
