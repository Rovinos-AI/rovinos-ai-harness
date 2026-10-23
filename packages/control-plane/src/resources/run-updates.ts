// SPDX-License-Identifier: Apache-2.0
import type { EventStore, RunSummary } from "@harness/store";
import type { Id } from "@harness/schemas";
import { RUNS_RESOURCE_URI, RUN_RESOURCE_URI_TEMPLATE } from "./runs.js";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

function runResourceUri(runId: Id): string {
  return RUN_RESOURCE_URI_TEMPLATE.replace("{runId}", runId);
}

/** Watches store changes and publishes resource URIs only, never event payloads. */
export function startRunResourceUpdates(
  store: EventStore,
  notify: (uri: string) => void,
): { close(): Promise<void> } {
  const controller = new AbortController();
  const watchers = new Map<Id, Promise<void>>();
  const publish = (runId: Id): void => {
    notify(RUNS_RESOURCE_URI);
    notify(runResourceUri(runId));
  };
  const watchRun = (summary: RunSummary): void => {
    if (terminalStatuses.has(summary.status) || watchers.has(summary.runId)) {
      return;
    }
    const watcher = (async () => {
      for await (const _event of store.watch(summary.runId, {
        fromSeq: summary.lastSeq + 1,
        signal: controller.signal,
      })) {
        publish(summary.runId);
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
  void updates.catch(() => undefined);
  return {
    async close(): Promise<void> {
      controller.abort();
      await Promise.all([updates, ...watchers.values()]);
    },
  };
}
