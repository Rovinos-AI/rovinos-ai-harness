// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { Id } from "@rovinos/schemas";

/** Atomically delete the events, snapshots, and row for a terminal run. */
export function deleteRunTransaction(db: Database.Database, runId: Id): number {
  const transaction = db.transaction(() => {
    const run = db
      .prepare<[Id], { status: string }>("SELECT status FROM runs WHERE run_id = ?")
      .get(runId);
    if (run === undefined || !["completed", "failed", "cancelled"].includes(run.status)) {
      return 0;
    }
    const activeReservation = db
      .prepare<[Id], { attempt_id: string }>(
        "SELECT attempt_id FROM spend_reservations WHERE run_id = ? AND state IN ('reserved', 'dispatching', 'uncertain') LIMIT 1",
      )
      .get(runId);
    if (activeReservation !== undefined) {
      return 0;
    }
    const eventCount = db.prepare<[Id]>("DELETE FROM events WHERE run_id = ?").run(runId).changes;
    db.prepare<[Id]>("DELETE FROM snapshots WHERE run_id = ?").run(runId);
    db.prepare<[Id]>("DELETE FROM approval_notifications WHERE run_id = ?").run(runId);
    db.prepare<[Id]>("DELETE FROM idempotency_keys WHERE run_id = ?").run(runId);
    db.prepare<[Id]>("DELETE FROM runs WHERE run_id = ?").run(runId);
    return eventCount;
  });
  return transaction.immediate();
}
