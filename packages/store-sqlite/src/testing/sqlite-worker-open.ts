// SPDX-License-Identifier: Apache-2.0
import { SqliteEventStore } from "../sqlite/adapter.js";

/** Opens a SQLite event store in the calling worker thread. */
export function openSqliteEventStore(args: { path: string }): SqliteEventStore {
  return new SqliteEventStore(args.path);
}
