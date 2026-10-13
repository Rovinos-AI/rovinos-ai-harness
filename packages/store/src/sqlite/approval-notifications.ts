// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { Id } from "@harness/schemas";
import { sqliteStoreError } from "./outbox.js";

/** Persists once-only escalation claims for a SQLite event store. */
export class SqliteApprovalNotifications {
  private readonly claimStatement: Database.Statement<[Id, Id]>;
  private readonly releaseStatement: Database.Statement<[Id, Id]>;

  /** Prepares approval notification statements for the open database. */
  constructor(private readonly db: Database.Database) {
    this.claimStatement = db.prepare<[Id, Id]>(
      "INSERT INTO approval_notifications (approval_id, run_id) VALUES (?, ?) ON CONFLICT (approval_id) DO NOTHING",
    );
    this.releaseStatement = db.prepare<[Id, Id]>(
      "DELETE FROM approval_notifications WHERE approval_id = ? AND run_id = ?",
    );
  }

  /** Atomically claim the unique notification for one approval. */
  claim(approvalId: Id, runId: Id): Promise<boolean> {
    try {
      return Promise.resolve(this.claimStatement.run(approvalId, runId).changes === 1);
    } catch (error) {
      return Promise.reject(sqliteStoreError(error));
    }
  }

  /** Release a notification claim when delivery fails. */
  release(approvalId: Id, runId: Id): Promise<void> {
    try {
      this.releaseStatement.run(approvalId, runId);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(sqliteStoreError(error));
    }
  }
}
