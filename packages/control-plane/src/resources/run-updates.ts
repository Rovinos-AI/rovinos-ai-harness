// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@harness/schemas";
import type { EventStore, RunSummary } from "@harness/store";
import type { Id } from "@harness/schemas";
import { RUNS_RESOURCE_URI, RUN_RESOURCE_URI_TEMPLATE } from "./runs.js";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_MAX_RUN_WATCHERS = 100;

/** A typed failure raised when live updates would exceed the watcher bound. */
export class RunResourceUpdatesError extends HarnessError {
  override readonly code = "run_update_watch_limit_exceeded";

  constructor() {
    super("The run resource update watcher limit was reached.");
  }
}

/** Optional concurrency and error-reporting controls for resource update watchers. */
export interface RunResourceUpdatesOptions {
  readonly maxWatchers?: number;
  readonly onError?: (error: RunResourceUpdatesError) => void;
}

function runResourceUri(runId: Id): string {
  return RUN_RESOURCE_URI_TEMPLATE.replace("{runId}", runId);
}

/** Watches store changes and publishes resource URIs only, never event payloads. */
export function startRunResourceUpdates(
  store: EventStore,
  notify: (uri: string) => void,
  options: RunResourceUpdatesOptions = {},
): { close(): Promise<void> } {
  const controller = new AbortController();
  const watchers = new Map<Id, Promise<void>>();
  const maxWatchers = options.maxWatchers ?? DEFAULT_MAX_RUN_WATCHERS;
  const publish = (runId: Id): void => {
    notify(RUNS_RESOURCE_URI);
    notify(runResourceUri(runId));
  };
  const watchRun = (summary: RunSummary): void => {
    if (terminalStatuses.has(summary.status) || watchers.has(summary.runId)) {
      return;
    }
    if (watchers.size >= maxWatchers) {
      throw new RunResourceUpdatesError();
    }
    const watcher = (async () => {
      for await (const event of store.watch(summary.runId, {
        fromSeq: summary.lastSeq + 1,
        signal: controller.signal,
      })) {
        publish(summary.runId);
        if (event.type === "run_status_changed" && terminalStatuses.has(event.to)) {
          break;
        }
      }
    })();
    watchers.set(summary.runId, watcher);
    const removeWatcher = (): void => {
      if (watchers.get(summary.runId) === watcher) {
        watchers.delete(summary.runId);
      }
    };
    void watcher.then(removeWatcher, removeWatcher);
  };
  const run = async (): Promise<void> => {
    for await (const summary of store.watchRuns({ signal: controller.signal })) {
      notify(RUNS_RESOURCE_URI);
      watchRun(summary);
    }
  };
  const updates = run();
  const settledUpdates = updates.catch((error: unknown) => {
    controller.abort();
    if (error instanceof RunResourceUpdatesError) {
      try {
        options.onError?.(error);
      } catch {
        return;
      }
      return;
    }
    throw error;
  });
  void settledUpdates.catch(() => undefined);
  return {
    async close(): Promise<void> {
      controller.abort();
      await Promise.all([settledUpdates, ...watchers.values()]);
    },
  };
}
