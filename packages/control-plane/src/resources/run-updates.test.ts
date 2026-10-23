// SPDX-License-Identifier: Apache-2.0
import { Id } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import { describe, expect, it, vi } from "vitest";
import {
  RunResourceUpdatesError,
  startRunResourceUpdates,
} from "./run-updates.js";

async function appendRunningRun(store: InMemoryEventStore, runId: Id): Promise<number> {
  const builders = createEventBuilders();
  await store.append(
    runId,
    [builders.runCreated(runId), builders.runStatusChanged(runId, "pending", "running")],
    0,
  );
  return 2;
}

describe("run resource updates", () => {
  it("reports a typed error when the concurrent watcher limit is reached", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const firstRunId = builders.nextRunId();
    const secondRunId = builders.nextRunId();
    await appendRunningRun(store, firstRunId);
    await appendRunningRun(store, secondRunId);
    const onError = vi.fn();
    const updates = startRunResourceUpdates(store, () => undefined, {
      maxWatchers: 1,
      onError,
    });

    try {
      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledOnce();
      });
      expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(RunResourceUpdatesError);
      expect(onError.mock.calls[0]?.[0].code).toBe("run_update_watch_limit_exceeded");
    } finally {
      await updates.close();
      await store.close();
    }
  });

  it("releases a watcher when its run becomes terminal", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const firstRunId = builders.nextRunId();
    await appendRunningRun(store, firstRunId);
    const originalWatch = store.watch.bind(store);
    let finishFirstWatch: () => void = () => undefined;
    const firstWatchFinished = new Promise<void>((resolve) => {
      finishFirstWatch = resolve;
    });
    const watch = vi.spyOn(store, "watch").mockImplementation((runId, options) => ({
      async *[Symbol.asyncIterator]() {
        try {
          yield* originalWatch(runId, options);
        } finally {
          if (runId === firstRunId) {
            finishFirstWatch();
          }
        }
      },
    }));
    const onError = vi.fn();
    const updates = startRunResourceUpdates(store, () => undefined, {
      maxWatchers: 1,
      onError,
    });

    try {
      await vi.waitFor(() => {
        expect(watch).toHaveBeenCalledOnce();
      });
      await store.append(
        firstRunId,
        [builders.runStatusChanged(firstRunId, "running", "completed")],
        2,
      );
      await firstWatchFinished;

      const secondRunId = builders.nextRunId();
      await appendRunningRun(store, secondRunId);
      await vi.waitFor(() => {
        expect(watch).toHaveBeenCalledTimes(2);
      });
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await updates.close();
      await store.close();
    }
  });
});
