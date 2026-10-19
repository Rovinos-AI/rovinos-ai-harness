// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SequentialIdGenerator } from "@harness/schemas";
import type { Clock } from "../types.js";
import { SqliteRunQueue } from "./sqlite.js";
import { runQueueConformance, type RunQueueFactoryCreator } from "./conformance.js";

let nextDirectory = 0;

const sqliteFactory: RunQueueFactoryCreator = async (clock: Clock) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-run-queue-"));
  const path = join(directory, `${nextDirectory++}.sqlite`);
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
