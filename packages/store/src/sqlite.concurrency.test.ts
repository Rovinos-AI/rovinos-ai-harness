// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "./index.js";
import { runConcurrencyConformance, type MultiEventStoreFactoryCreator } from "./testing/index.js";

const sqliteMultiFactory: MultiEventStoreFactoryCreator = async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-store-concurrency-"));
  const path = join(directory, "events.sqlite");
  const stores: SqliteEventStore[] = [];

  return {
    open() {
      const store = new SqliteEventStore(path);
      stores.push(store);
      return Promise.resolve(store);
    },
    async cleanup() {
      try {
        await Promise.all(stores.map((store) => store.close()));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
};

runConcurrencyConformance("SqliteEventStore", sqliteMultiFactory);
