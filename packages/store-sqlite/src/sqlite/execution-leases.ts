// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { Id } from "@rovinos/schemas";

interface SqliteExecutionLeaseOptions {
  readonly db: Database.Database;
  readonly runId: Id;
  readonly owner: Id;
  readonly now: number;
  readonly leaseMs: number;
}

/** Claims a SQLite run-execution lease until its expiry. */
export function claimSqliteExecutionLease(options: SqliteExecutionLeaseOptions): Promise<boolean> {
  const { db, runId, owner, now, leaseMs } = options;
  const result = db
    .prepare<[Id, Id, number, number], { changes: number }>(
      "INSERT INTO run_execution_leases (run_id, owner_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at WHERE run_execution_leases.expires_at <= ?",
    )
    .run(runId, owner, now + leaseMs, now);
  return Promise.resolve(result.changes === 1);
}

/** Renews the current owner's unexpired SQLite run-execution lease. */
export function renewSqliteExecutionLease(options: SqliteExecutionLeaseOptions): Promise<boolean> {
  const { db, runId, owner, now, leaseMs } = options;
  const result = db
    .prepare<[number, Id, Id, number], { changes: number }>(
      "UPDATE run_execution_leases SET expires_at = ? WHERE run_id = ? AND owner_id = ? AND expires_at > ?",
    )
    .run(now + leaseMs, runId, owner, now);
  return Promise.resolve(result.changes === 1);
}

/** Releases the SQLite run-execution lease only when the owner still matches. */
export function releaseSqliteExecutionLease(
  options: Pick<SqliteExecutionLeaseOptions, "db" | "runId" | "owner">,
): Promise<void> {
  const { db, runId, owner } = options;
  db.prepare<[Id, Id]>("DELETE FROM run_execution_leases WHERE run_id = ? AND owner_id = ?").run(
    runId,
    owner,
  );
  return Promise.resolve();
}
