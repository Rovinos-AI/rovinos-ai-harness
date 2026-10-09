// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { SqliteEventStore, runEventStoreConformance } from "./index.js";
import type { EventStoreFactory } from "./conformance.js";

let directory: string | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "harness-store-conformance-"));
});

afterAll(async () => {
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
  }
});

const sqliteFactory: EventStoreFactory = () =>
  Promise.resolve().then(() => {
    if (directory === undefined) {
      throw new Error("SQLite conformance directory is not initialized");
    }
    const store = new SqliteEventStore(join(directory, "events.sqlite"));
    return { store, cleanup: () => store.close() };
  });

runEventStoreConformance("SqliteEventStore", sqliteFactory, { supportsFileReopen: true });
