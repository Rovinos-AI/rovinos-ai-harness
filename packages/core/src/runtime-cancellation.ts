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

/** Reads new events and aborts local work when durable cancellation is observed. */
export async function inspectCancellationTail(options: CancellationTailOptions): Promise<boolean> {
  const events: Event[] = [];
  for await (const event of options.store.read(options.runId, { fromSeq: options.fromSeq })) {
    events.push(event);
  }
  for (const event of events) {
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

/** Polls the event store for durable cancellation, backing off when reads fail. */
export async function watchCancellation(options: CancellationWatchOptions): Promise<void> {
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
