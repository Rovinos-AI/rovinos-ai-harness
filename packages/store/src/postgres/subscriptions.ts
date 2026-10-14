// SPDX-License-Identifier: Apache-2.0
import type { Id } from "@harness/schemas";
import type { Notification, Pool, PoolClient } from "pg";
import { integer, storeError } from "./helpers.js";

/** Open a Postgres listener for committed harness event notifications. */
export async function listenForChanges(
  pool: Pool,
  ensureInitialized: () => Promise<void>,
  onNotification: (message: Notification) => void,
): Promise<{ client: PoolClient; close: () => Promise<void> }> {
  await ensureInitialized();
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw storeError(error);
  }
  client.on("notification", onNotification);
  try {
    await client.query("LISTEN harness_events");
  } catch (error) {
    client.removeListener("notification", onNotification);
    client.release();
    throw storeError(error);
  }
  return {
    client,
    async close() {
      client.removeListener("notification", onNotification);
      await client.query("UNLISTEN harness_events").catch(() => undefined);
      client.release();
    },
  };
}

/** Check whether the stored run has reached a terminal state through the observed head. */
export async function isRunTerminal(
  pool: Pool,
  ensureInitialized: () => Promise<void>,
  runId: Id,
  observedNextSeq: number,
): Promise<boolean> {
  try {
    await ensureInitialized();
    const result = await pool.query<{ next_seq: number | string; status: string }>(
      "SELECT next_seq, status FROM runs WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    return (
      row !== undefined &&
      integer(row.next_seq) <= observedNextSeq &&
      (row.status === "completed" || row.status === "failed" || row.status === "cancelled")
    );
  } catch (error) {
    throw storeError(error);
  }
}
