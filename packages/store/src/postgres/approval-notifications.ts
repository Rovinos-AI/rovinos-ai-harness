// SPDX-License-Identifier: Apache-2.0
import type { Id } from "@harness/schemas";
import type { Pool } from "pg";
import { storeError } from "./helpers.js";

/** Persists once-only escalation claims for a Postgres event store. */
export class PostgresApprovalNotifications {
  constructor(
    private readonly pool: Pool,
    private readonly ensureInitialized: () => Promise<void>,
  ) {}

  /** Atomically claim the unique notification for one approval. */
  async claim(approvalId: Id, runId: Id): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query(
        "INSERT INTO approval_notifications (approval_id, run_id) VALUES ($1, $2) ON CONFLICT (approval_id) DO NOTHING RETURNING approval_id",
        [approvalId, runId],
      );
      return result.rows.length === 1;
    } catch (error) {
      throw storeError(error);
    }
  }

  /** Release a notification claim when delivery fails. */
  async release(approvalId: Id, runId: Id): Promise<void> {
    try {
      await this.ensureInitialized();
      await this.pool.query(
        "DELETE FROM approval_notifications WHERE approval_id = $1 AND run_id = $2",
        [approvalId, runId],
      );
    } catch (error) {
      throw storeError(error);
    }
  }
}
