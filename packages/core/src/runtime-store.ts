// SPDX-License-Identifier: Apache-2.0
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SqliteEventStore, type EventStore } from "@harness/store";

/** Creates the runtime's SQLite event store under its selected data directory. */
export async function createSqliteStore(dataDir: string, readOnly: boolean): Promise<EventStore> {
  if (!readOnly) {
    await mkdir(dataDir, { recursive: true });
  }
  return new SqliteEventStore(join(dataDir, "harness.db"), undefined, { readOnly });
}
