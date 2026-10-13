// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { Id } from "@harness/schemas";
import { sqliteStoreError } from "./outbox.js";

/** Persists once-only escalation claims for a SQLite event store. */
export class SqliteApprovalNotifications {
  private readonly claimStatement: Database.Statement<[Id, Id, number, number]>;
  private readonly markSentStatement: Database.Statement<[number, Id, Id, number]>;
  private readonly releaseStatement: Database.Statement<[Id, Id, number]>;

  /** Prepares approval notification statements for the open database. */
  constructor(private readonly db: Database.Database) {
    this.claimStatement = db.prepare<[Id, Id, number, number]>(
      "INSERT INTO approval_notifications (approval_id, run_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT (approval_id) DO UPDATE SET claimed_at = excluded.claimed_at WHERE approval_notifications.run_id = excluded.run_id AND approval_notifications.sent_at IS NULL AND approval_notifications.claimed_at <= excluded.claimed_at - ?",
    );
    this.markSentStatement = db.prepare<[number, Id, Id, number]>(
      "UPDATE approval_notifications SET sent_at = ? WHERE approval_id = ? AND run_id = ? AND claimed_at = ? AND sent_at IS NULL",
    );
    this.releaseStatement = db.prepare<[Id, Id, number]>(
      "DELETE FROM approval_notifications WHERE approval_id = ? AND run_id = ? AND claimed_at = ? AND sent_at IS NULL",
    );
  }

  /** Atomically claim the unique notification for one approval. */
  claim(approvalId: Id, runId: Id, claimedAt: number, leaseMs: number): Promise<boolean> {
    try {
      return Promise.resolve(
        this.claimStatement.run(approvalId, runId, claimedAt, leaseMs).changes === 1,
      );
    } catch (error) {
      return Promise.reject(sqliteStoreError(error));
    }
  }

  /** Mark a successfully delivered notification as sent if this claim is still current. */
  markSent(approvalId: Id, runId: Id, claimedAt: number, sentAt: number): Promise<boolean> {
    try {
      return Promise.resolve(
        this.markSentStatement.run(sentAt, approvalId, runId, claimedAt).changes === 1,
      );
    } catch (error) {
      return Promise.reject(sqliteStoreError(error));
    }
  }

  /** Release a notification claim when delivery fails. */
  release(approvalId: Id, runId: Id, claimedAt: number): Promise<void> {
    try {
      this.releaseStatement.run(approvalId, runId, claimedAt);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(sqliteStoreError(error));
    }
  }
}
