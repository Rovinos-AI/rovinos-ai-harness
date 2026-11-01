// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, Id, QuotasConfigSchema, SequentialIdGenerator } from "@rovinos/schemas";
import { createEventBuilders } from "@rovinos/store/testing";
import { SqliteEventStore, SqliteRunQueue } from "@rovinos/store-sqlite";
import * as telemetry from "@rovinos/telemetry";
import { expect, it, vi } from "vitest";
import { QuotaService } from "./quotas.js";
import { Worker } from "./worker.js";

it("keeps matching runs within maxConcurrentRuns across two SQLite workers", async () => {
  const quotaRejection = vi.spyOn(telemetry, "countQuotaRejection");
  const directory = await mkdtemp(join(tmpdir(), "harness-worker-quota-"));
  const path = join(directory, "harness.db");
  const clock = new FakeClock(100);
  const ids = new SequentialIdGenerator();
  const store = new SqliteEventStore(path);
  const firstQueue = new SqliteRunQueue(path, {}, clock, ids);
  const secondQueue = new SqliteRunQueue(path, {}, clock, ids);
  const builders = createEventBuilders();
  const runIds = [
    Id.parse("00000000000000000000000031"),
    Id.parse("00000000000000000000000032"),
  ] as const;
  const quotaService = new QuotaService(
    QuotasConfigSchema.parse([
      {
        id: "research_team",
        match: { requestedBy: ["cli.alice"], role: ["researcher"] },
        maxConcurrentRuns: 1,
      },
    ]),
    store,
    clock,
  );
  let firstWorker: Worker | undefined;
  let secondWorker: Worker | undefined;
  let finishFirstRun: () => void = () => undefined;
  let workerRuns: Promise<void>[] = [];
  let resolveFirstStarted: () => void = () => undefined;
  let resolveSecondStarted: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    resolveSecondStarted = resolve;
  });
  let activeRuns = 0;
  let maximumActiveRuns = 0;
  let secondRunStarted = false;
  const firstRunGate = new Promise<void>((resolve) => {
    finishFirstRun = resolve;
  });

  const setStatus = async (
    runId: Id,
    from: "pending" | "running",
    to: "running" | "completed",
  ): Promise<void> => {
    const nextSeq = await store.head(runId);
    await store.append(
      runId,
      [
        {
          runId,
          ts: clock.now(),
          v: 1,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId: runId,
          type: "run_status_changed",
          from,
          to,
          reason: "worker.test",
        },
      ],
      nextSeq,
    );
  };

  const execute = async (job: { readonly runId: string }) => {
    const runId = Id.parse(job.runId);
    await setStatus(runId, "pending", "running");
    activeRuns += 1;
    maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
    if (runId === runIds[0]) {
      resolveFirstStarted();
      await firstRunGate;
    } else {
      secondRunStarted = true;
      resolveSecondStarted();
    }
    await setStatus(runId, "running", "completed");
    activeRuns -= 1;
    if (runId === runIds[1]) {
      firstWorker?.stop();
      secondWorker?.stop();
    }
    return { status: "completed" as const };
  };

  try {
    await Promise.all(
      runIds.map((runId) =>
        store.append(
          runId,
          [
            {
              ...builders.runCreated(runId),
              requestedBy: "cli.alice",
              quotaRole: "researcher",
            },
          ],
          0,
        ),
      ),
    );
    await Promise.all(runIds.map((runId) => firstQueue.enqueue({ kind: "start", runId })));

    firstWorker = new Worker({
      queue: firstQueue,
      ids,
      clock,
      quotaService,
      pollIntervalMs: 2,
      execute,
    });
    secondWorker = new Worker({
      queue: secondQueue,
      ids,
      clock,
      quotaService,
      pollIntervalMs: 2,
      execute,
    });
    workerRuns = [firstWorker.run(), secondWorker.run()];

    await firstStarted;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondRunStarted).toBe(false);
    expect((await store.listRuns({ status: "running", limit: 10 })).runs).toHaveLength(1);
    expect(maximumActiveRuns).toBe(1);
    expect(quotaRejection).toHaveBeenCalledWith("research_team");

    finishFirstRun();
    await secondStarted;
    await Promise.all(workerRuns);

    expect(maximumActiveRuns).toBe(1);
    expect(activeRuns).toBe(0);
  } finally {
    firstWorker?.stop();
    secondWorker?.stop();
    finishFirstRun();
    await Promise.allSettled(workerRuns);
    await Promise.all([firstQueue.close(), secondQueue.close(), store.close()]);
    await rm(directory, { recursive: true, force: true });
    quotaRejection.mockRestore();
  }
});
