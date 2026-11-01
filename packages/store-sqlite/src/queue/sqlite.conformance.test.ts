// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { FakeClock, Id, SequentialIdGenerator } from "@rovinos/schemas";
import type { Clock } from "@rovinos/store";
import { createEventBuilders } from "@rovinos/store/testing";
import { SqliteEventStore } from "../sqlite/adapter.js";
import { SqliteRunQueue } from "./sqlite.js";
import { runQueueConformance, type RunQueueFactoryCreator } from "@rovinos/store/testing";

let nextDirectory = 0;

const sqliteFactory: RunQueueFactoryCreator = async (clock: Clock) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-run-queue-"));
  const path = join(directory, `${String(nextDirectory++)}.sqlite`);
  const ids = new SequentialIdGenerator();
  const queues = new Set<SqliteRunQueue>();
  const store = new SqliteEventStore(path);
  const builders = createEventBuilders();
  return {
    open() {
      const queue = new SqliteRunQueue(path, {}, clock, ids);
      queues.add(queue);
      return queue;
    },
    async seedRun(runId, identity) {
      const id = Id.parse(runId);
      await store.append(
        id,
        [
          {
            ...builders.runCreated(id),
            ...(identity.requestedBy === undefined ? {} : { requestedBy: identity.requestedBy }),
            ...(identity.role === undefined ? {} : { quotaRole: identity.role }),
          },
        ],
        0,
      );
    },
    async markRunning(runId) {
      const id = Id.parse(runId);
      await store.append(
        id,
        [builders.runStatusChanged(id, "pending", "running")],
        await store.head(id),
      );
    },
    async cleanup() {
      await Promise.all([...queues].map((queue) => queue.close()));
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

runQueueConformance("SqliteRunQueue", sqliteFactory);

it("opens a new queue database before any event store exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-run-queue-fresh-"));
  const path = join(directory, "fresh.sqlite");
  let queue: SqliteRunQueue | undefined;
  try {
    queue = new SqliteRunQueue(path, {}, new FakeClock(100), new SequentialIdGenerator());
    await expect(
      queue.enqueue({ kind: "start", runId: "00000000000000000000000040" }),
    ).resolves.toMatchObject({ runId: "00000000000000000000000040" });
  } finally {
    await queue?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("opens a read-only queue without an events table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-run-queue-readonly-"));
  const path = join(directory, "readonly.sqlite");
  let queue: SqliteRunQueue | undefined;
  try {
    queue = new SqliteRunQueue(path, {}, new FakeClock(100), new SequentialIdGenerator());
    await queue.close();
    queue = undefined;
    const database = new Database(path);
    database.exec("DROP TABLE events");
    database.close();

    queue = new SqliteRunQueue(path, { readOnly: true }, new FakeClock(100));
    expect(queue).toBeDefined();
  } finally {
    await queue?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses the active-lease index for quota-capacity lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-run-queue-index-"));
  const path = join(directory, "indexed.sqlite");
  let queue: SqliteRunQueue | undefined;
  try {
    queue = new SqliteRunQueue(path, {}, new FakeClock(100), new SequentialIdGenerator());
    await queue.close();
    queue = undefined;
    const database = new Database(path, { readonly: true });
    const plan = database
      .prepare<[number], { detail: string }>(
        "EXPLAIN QUERY PLAN SELECT DISTINCT e.run_id FROM run_queue AS q INDEXED BY run_queue_active_lease_idx JOIN events AS e ON e.run_id = q.run_id AND e.type = 'run_created' WHERE q.lease_owner IS NOT NULL AND q.lease_expires_at > ?",
      )
      .all(100);
    database.close();

    expect(plan.map(({ detail }) => detail).join(" ")).toContain("run_queue_active_lease_idx");
  } finally {
    await queue?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("sets claim deadlines after BEGIN IMMEDIATE waits for a writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-run-queue-lock-"));
  const path = join(directory, "queue.sqlite");
  const sharedTime = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.store(sharedTime, 0, 100);
  const clock: Clock = { now: () => Atomics.load(sharedTime, 0) };
  const queue = new SqliteRunQueue(path, {}, clock, new SequentialIdGenerator());
  let lockWorker: Worker | undefined;
  try {
    await queue.enqueue({
      kind: "start",
      runId: "00000000000000000000000015",
    });
    lockWorker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const Database = require("better-sqlite3");
        const db = new Database(workerData.path);
        db.exec("BEGIN IMMEDIATE");
        parentPort.postMessage("locked");
        setTimeout(() => {
          Atomics.store(new Int32Array(workerData.clock), 0, 200);
          db.exec("COMMIT");
          db.close();
        }, 100);
      `,
      {
        eval: true,
        workerData: { path, clock: sharedTime.buffer },
      },
    );
    const locked = new Promise<void>((resolve, reject) => {
      lockWorker?.once("message", (message: unknown) => {
        if (message === "locked") {
          resolve();
        } else {
          reject(new Error("SQLite lock worker returned an unexpected message"));
        }
      });
      lockWorker?.once("error", reject);
    });
    await locked;

    const [claimed] = await queue.claim("worker.after_lock", 1, 50);

    expect(claimed?.leaseExpiresAt).toBe(250);
  } finally {
    await queue.close();
    await lockWorker?.terminate();
    await rm(directory, { recursive: true, force: true });
  }
});
