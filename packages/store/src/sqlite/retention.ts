// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { Id } from "@harness/schemas";

/** Atomically delete the events, snapshots, and row for a terminal run. */
export function deleteRunTransaction(db: Database.Database, runId: Id): number {
  const transaction = db.transaction(() => {
    const run = db
      .prepare<[Id], { status: string }>("SELECT status FROM runs WHERE run_id = ?")
      .get(runId);
    if (run === undefined || !["completed", "failed", "cancelled"].includes(run.status)) {
      return 0;
    }
    const eventCount = db.prepare<[Id]>("DELETE FROM events WHERE run_id = ?").run(runId).changes;
    db.prepare<[Id]>("DELETE FROM snapshots WHERE run_id = ?").run(runId);
    db.prepare<[Id]>("DELETE FROM runs WHERE run_id = ?").run(runId);
    return eventCount;
  });
  return transaction.immediate();
}
