// SPDX-License-Identifier: Apache-2.0
import type { Id } from "@harness/schemas";
import type { PoolClient, QueryResultRow } from "pg";

/** Delete a terminal run under the same row lock used by append transactions. */
export async function deleteRunTransaction(client: PoolClient, runId: Id): Promise<number> {
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const runResult = await client.query<{ status: string } & QueryResultRow>(
      "SELECT status FROM runs WHERE run_id = $1 FOR UPDATE",
      [runId],
    );
    const status = runResult.rows[0]?.status;
    if (status !== "completed" && status !== "failed" && status !== "cancelled") {
      await client.query("COMMIT");
      transactionStarted = false;
      return 0;
    }
    const events = await client.query("DELETE FROM events WHERE run_id = $1", [runId]);
    await client.query("DELETE FROM snapshots WHERE run_id = $1", [runId]);
    await client.query("DELETE FROM approval_notifications WHERE run_id = $1", [runId]);
    await client.query("DELETE FROM runs WHERE run_id = $1", [runId]);
    await client.query("COMMIT");
    transactionStarted = false;
    return events.rowCount ?? 0;
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  }
}
