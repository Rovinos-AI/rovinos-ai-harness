// SPDX-License-Identifier: Apache-2.0
import { FakeClock, Id, QuotasConfigSchema, SequentialIdGenerator } from "@rovinos/schemas";
import { SystemRunQueueIdGenerator } from "@rovinos/store";
import { createEventBuilders } from "@rovinos/store/testing";
import { PostgresEventStore, PostgresRunQueue } from "@rovinos/store-postgres";
import * as telemetry from "@rovinos/telemetry";
import { expect, it, vi } from "vitest";
import { QuotaService } from "./quotas.js";
import { Worker } from "./worker.js";

const connectionString =
  process.env.TEST_POSTGRES_URL ?? "postgresql://harness@127.0.0.1:5432/harness";

it("records one quota rejection when a Postgres worker defers a job across repeated polls", async () => {
  const clock = new FakeClock(100);
  const ids = new SystemRunQueueIdGenerator(clock);
  const workerIds = new SequentialIdGenerator();
  const firstRunId = Id.parse(ids.next());
  const secondRunId = Id.parse(ids.next());
  const store = new PostgresEventStore(connectionString, { poolSize: 4 }, undefined, clock);
  const firstQueue = new PostgresRunQueue(
    connectionString,
    { poolSize: 3 },
    clock,
    new SystemRunQueueIdGenerator(clock),
  );
  const secondQueue = new PostgresRunQueue(
    connectionString,
    { poolSize: 3 },
    clock,
    new SystemRunQueueIdGenerator(clock),
  );
  const builders = createEventBuilders();
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
  const quotaRejection = vi.spyOn(telemetry, "countQuotaRejection");
  let firstWorker: Worker | undefined;
  let secondWorker: Worker | undefined;
  let finishFirstRun: () => void = () => undefined;
  let workerRuns: Promise<void>[] = [];
  let resolveFirstStarted: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const firstRunGate = new Promise<void>((resolve) => {
    finishFirstRun = resolve;
  });

  const appendStatus = async (
    runId: Id,
    from: "pending" | "running",
    to: "running" | "completed",
  ): Promise<void> => {
    await store.append(
      runId,
      [builders.runStatusChanged(runId, from, to)],
      await store.head(runId),
    );
  };
  const execute = async ({ runId: rawRunId }: { readonly runId: string }) => {
    const runId = Id.parse(rawRunId);
    await appendStatus(runId, "pending", "running");
    if (runId === firstRunId) {
      resolveFirstStarted();
      await firstRunGate;
    }
    await appendStatus(runId, "running", "completed");
    if (runId === secondRunId) {
      firstWorker?.stop();
      secondWorker?.stop();
    }
    return { status: "completed" as const };
  };

  try {
    await Promise.all(
      [firstRunId, secondRunId].map((runId) =>
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
    await firstQueue.enqueue({ kind: "start", runId: firstRunId, priority: 1 });
    await firstQueue.enqueue({ kind: "start", runId: secondRunId });
    firstWorker = new Worker({
      queue: firstQueue,
      ids: workerIds,
      clock,
      quotaService,
      pollIntervalMs: 2,
      execute,
    });
    secondWorker = new Worker({
      queue: secondQueue,
      ids: workerIds,
      clock,
      quotaService,
      pollIntervalMs: 2,
      execute,
    });
    workerRuns = [firstWorker.run(), secondWorker.run()];

    await firstStarted;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(quotaRejection).toHaveBeenCalledTimes(1);
    expect(quotaRejection).toHaveBeenCalledWith("research_team");

    finishFirstRun();
    await Promise.all(workerRuns);
  } finally {
    firstWorker?.stop();
    secondWorker?.stop();
    finishFirstRun();
    await Promise.allSettled(workerRuns);
    await Promise.all([firstQueue.close(), secondQueue.close()]);
    await Promise.all([firstRunId, secondRunId].map((runId) => store.deleteRun(runId)));
    await store.close();
    quotaRejection.mockRestore();
  }
});
