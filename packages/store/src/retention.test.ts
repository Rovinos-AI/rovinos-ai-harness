// SPDX-License-Identifier: Apache-2.0
import { FakeClock, type RunStatus, type StoreRetentionConfig } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
import { InMemoryEventStore } from "./memory.js";
import { purgeExpiredRuns, type RetentionLogger } from "./retention.js";
import { createEventBuilders } from "./testing/testing.js";

const DAY = 86_400_000;
const policy: StoreRetentionConfig = {
  completedRunsDays: 10,
  failedRunsDays: 5,
  snapshotKeep: 5,
};
const builders = createEventBuilders();

async function seedRun(
  store: InMemoryEventStore,
  status: RunStatus,
  lastTs: number,
): Promise<string> {
  const runId = builders.nextRunId();
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

    expect(result).toEqual({ examined: 6, purged: 3, skippedActive: 2 });
    expect(hookCalls).toEqual([completedExpired, failedExpired, cancelledExpired]);
    expect(info).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenCalledWith("run_purged", { "harness.run_id": completedExpired });
    await expect(store.head(completedAtCutoff)).resolves.toBe(2);
  });

  it("returns the same counts in dry-run mode without deleting or calling the hook", async () => {
    const store = new InMemoryEventStore();
    const now = 100 * DAY;
    const runId = await seedRun(store, "completed", now - 11 * DAY);
    const onRunPurged = vi.fn();

    await expect(
      purgeExpiredRuns({
        store,
        clock: new FakeClock(now),
        policy,
        onRunPurged,
        dryRun: true,
      }),
    ).resolves.toEqual({ examined: 1, purged: 0, skippedActive: 0 });

    expect(onRunPurged).not.toHaveBeenCalled();
    await expect(store.head(runId)).resolves.toBe(2);
  });

  it("reports hook failure without undoing deletion or stopping the purge", async () => {
    const store = new InMemoryEventStore();
    const now = 100 * DAY;
    const runId = await seedRun(store, "completed", now - 11 * DAY);
    const info = vi.fn();
    const error = vi.fn();

    await expect(
      purgeExpiredRuns({
        store,
        clock: new FakeClock(now),
        policy,
        logger: { info, error },
        onRunPurged: async () => {
          throw new Error("synthetic hook failure");
        },
        dryRun: false,
      }),
    ).resolves.toEqual({ examined: 1, purged: 1, skippedActive: 0 });

    await expect(store.head(runId)).resolves.toBe(0);
    expect(info).toHaveBeenCalledWith("run_purged", { "harness.run_id": runId });
    expect(error).toHaveBeenCalledWith("run_purge_hook_failed", { "harness.run_id": runId });
  });

  it("paginates beyond one batch while preserving run-id cursors during deletion", async () => {
    const store = new InMemoryEventStore();
    const now = 100 * DAY;
    for (let index = 0; index < 205; index += 1) {
      await seedRun(store, "completed", now - 11 * DAY);
    }

    await expect(
      purgeExpiredRuns({ store, clock: new FakeClock(now), policy, dryRun: false }),
    ).resolves.toEqual({ examined: 205, purged: 205, skippedActive: 0 });
    await expect(store.listRuns({ limit: 1 })).resolves.toEqual({ runs: [] });
  });
});
