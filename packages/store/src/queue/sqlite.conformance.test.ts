// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { SequentialIdGenerator } from "@harness/schemas";
import type { Clock } from "../types.js";
import { SqliteRunQueue } from "./sqlite.js";
import { runQueueConformance, type RunQueueFactoryCreator } from "./conformance.js";

let nextDirectory = 0;

const sqliteFactory: RunQueueFactoryCreator = async (clock: Clock) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-run-queue-"));
  const path = join(directory, `${String(nextDirectory++)}.sqlite`);
  const ids = new SequentialIdGenerator();
  const queues = new Set<SqliteRunQueue>();
  return {
    open() {
      const queue = new SqliteRunQueue(path, {}, clock, ids);
      queues.add(queue);
      return queue;
    },
    async cleanup() {
      await Promise.all([...queues].map((queue) => queue.close()));
      await rm(directory, { recursive: true, force: true });
    },
  };
};

runQueueConformance("SqliteRunQueue", sqliteFactory);

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
