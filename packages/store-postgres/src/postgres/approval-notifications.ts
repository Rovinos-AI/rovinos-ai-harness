// SPDX-License-Identifier: Apache-2.0
import type { Id } from "@rovinos/schemas";
import type { Pool } from "pg";
import { storeError } from "./helpers.js";

/** Persists once-only escalation claims for a Postgres event store. */
export class PostgresApprovalNotifications {
  constructor(
    private readonly pool: Pool,
    private readonly ensureInitialized: () => Promise<void>,
  ) {}

  /** Atomically claim the unique notification for one approval. */
  async claim(approvalId: Id, runId: Id, claimedAt: number, leaseMs: number): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query(
        "INSERT INTO approval_notifications (approval_id, run_id, claimed_at) VALUES ($1, $2, $3) ON CONFLICT (approval_id) DO UPDATE SET claimed_at = EXCLUDED.claimed_at WHERE approval_notifications.run_id = EXCLUDED.run_id AND approval_notifications.sent_at IS NULL AND approval_notifications.claimed_at <= EXCLUDED.claimed_at - $4 RETURNING approval_id",
        [approvalId, runId, claimedAt, leaseMs],
      );
      return result.rows.length === 1;
    } catch (error) {
      throw storeError(error);
    }
  }

  /** Mark a successfully delivered notification as sent if this claim is still current. */
  async markSent(approvalId: Id, runId: Id, claimedAt: number, sentAt: number): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query(
        "UPDATE approval_notifications SET sent_at = $1 WHERE approval_id = $2 AND run_id = $3 AND claimed_at = $4 AND sent_at IS NULL",
        [sentAt, approvalId, runId, claimedAt],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw storeError(error);
    }
  }

  /** Release a notification claim when delivery fails. */
  async release(approvalId: Id, runId: Id, claimedAt: number): Promise<void> {
    try {
      await this.ensureInitialized();
      await this.pool.query(
        "DELETE FROM approval_notifications WHERE approval_id = $1 AND run_id = $2 AND claimed_at = $3 AND sent_at IS NULL",
        [approvalId, runId, claimedAt],
      );
    } catch (error) {
      throw storeError(error);
    }
  }
}
