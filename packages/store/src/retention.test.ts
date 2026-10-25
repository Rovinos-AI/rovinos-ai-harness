// SPDX-License-Identifier: Apache-2.0
import { FakeClock, type Id, type RunStatus, type StoreRetentionConfig } from "@rovinos/schemas";
import { describe, expect, it, vi } from "vitest";
import { InMemoryEventStore } from "./memory.js";
import { purgeExpiredRuns, type RetentionLogger } from "./retention.js";
import { createEventBuilders } from "./testing/testing.js";

const DAY = 86_400_000;
const policy: StoreRetentionConfig = {
  completedRunsDays: 10,
  failedRunsDays: 5,
};
const builders = createEventBuilders();

async function seedRun(
  store: InMemoryEventStore,
  status: RunStatus,
  lastTs: number,
  runId: Id = builders.nextRunId(),
): Promise<string> {
  const created = { ...builders.runCreated(runId), ts: lastTs - 1 };
  if (status === "pending") {
    await store.append(runId, [created], 0);
    return runId;
  }
  await store.append(
    runId,
    [created, { ...builders.runStatusChanged(runId, "pending", status), ts: lastTs }],
    0,
  );
  return runId;
}

describe("purgeExpiredRuns", () => {
  it("deletes only runs strictly older than their status-specific cutoff", async () => {
    const store = new InMemoryEventStore();
    const now = 100 * DAY;
    const clock = new FakeClock(now);
    const completedExpired = await seedRun(store, "completed", now - 10 * DAY - 1);
    const completedAtCutoff = await seedRun(store, "completed", now - 10 * DAY);
    const failedExpired = await seedRun(store, "failed", now - 5 * DAY - 1);
    const cancelledExpired = await seedRun(store, "cancelled", now - 5 * DAY - 1);
    const cancelledAtCutoff = await seedRun(store, "cancelled", now - 5 * DAY);
    await seedRun(store, "running", now - 20 * DAY);
    await seedRun(store, "suspended", now - 20 * DAY);
    const hookCalls: string[] = [];
    const info = vi.fn();
    const logger: RetentionLogger = { info, error: vi.fn() };

    const result = await purgeExpiredRuns({
      store,
      clock,
      policy,
      logger,
      onRunPurged: async (runId) => {
        expect(await store.head(runId)).toBe(0);
        hookCalls.push(runId);
      },
      dryRun: false,
    });

    expect(result).toEqual({ examined: 7, purged: 3, skippedActive: 2, hookFailures: 0 });
    expect(hookCalls).toEqual([completedExpired, failedExpired, cancelledExpired]);
    expect(info).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenCalledWith("run_purged", { "harness.run.id": completedExpired });
    await expect(store.head(completedAtCutoff)).resolves.toBe(2);
    await expect(store.head(cancelledAtCutoff)).resolves.toBe(2);
  });

  it("returns the same counts in dry-run mode without changing the fixture or calling the hook", async () => {
    const dryStore = new InMemoryEventStore();
    const liveStore = new InMemoryEventStore();
    const now = 100 * DAY;
    const runIds = [
      builders.nextRunId(),
      builders.nextRunId(),
      builders.nextRunId(),
      builders.nextRunId(),
    ];
    for (const store of [dryStore, liveStore]) {
      await seedRun(store, "completed", now - 11 * DAY, runIds[0]);
      await seedRun(store, "completed", now - 10 * DAY, runIds[1]);
      await seedRun(store, "cancelled", now - 6 * DAY, runIds[2]);
      await seedRun(store, "running", now - 20 * DAY, runIds[3]);
    }
    const originalHeads = await Promise.all(runIds.map((runId) => dryStore.head(runId)));
    const originalRuns = await dryStore.listRuns({ limit: 100 });
    const onRunPurged = vi.fn();

    const dryResult = await purgeExpiredRuns({
      store: dryStore,
      clock: new FakeClock(now),
      policy,
      onRunPurged,
      dryRun: true,
    });
    const liveResult = await purgeExpiredRuns({
      store: liveStore,
      clock: new FakeClock(now),
      policy,
      dryRun: false,
    });

    expect(dryResult).toEqual({ examined: 4, purged: 2, skippedActive: 1, hookFailures: 0 });
    expect(dryResult).toEqual(liveResult);
    expect(onRunPurged).not.toHaveBeenCalled();
    await expect(Promise.all(runIds.map((runId) => dryStore.head(runId)))).resolves.toEqual(
      originalHeads,
    );
    await expect(dryStore.listRuns({ limit: 100 })).resolves.toEqual(originalRuns);
  });

  it("reports hook failure without undoing deletion or stopping the purge", async () => {
    const store = new InMemoryEventStore();
    const now = 100 * DAY;
    const runId = await seedRun(store, "completed", now - 11 * DAY);
    const info = vi.fn();
    const error = vi.fn();

    const result = await purgeExpiredRuns({
      store,
      clock: new FakeClock(now),
      policy,
      logger: { info, error },
      onRunPurged: () => Promise.reject(new Error("synthetic hook failure")),
      dryRun: false,
    });

    expect(result).toEqual({ examined: 1, purged: 1, skippedActive: 0, hookFailures: 1 });
    await expect(store.head(runId)).resolves.toBe(0);
    expect(info).toHaveBeenCalledWith("run_purged", { "harness.run.id": runId });
    expect(error).toHaveBeenCalledWith("run_purge_hook_failed", { "harness.run.id": runId });
  });

  it("paginates beyond one batch while preserving run-id cursors during deletion", async () => {
    const store = new InMemoryEventStore();
    const now = 100 * DAY;
    for (let index = 0; index < 205; index += 1) {
      await seedRun(store, "completed", now - 11 * DAY);
    }

    await expect(
      purgeExpiredRuns({ store, clock: new FakeClock(now), policy, dryRun: false }),
    ).resolves.toEqual({ examined: 205, purged: 205, skippedActive: 0, hookFailures: 0 });
    await expect(store.listRuns({ limit: 1 })).resolves.toEqual({ runs: [] });
  });
});
