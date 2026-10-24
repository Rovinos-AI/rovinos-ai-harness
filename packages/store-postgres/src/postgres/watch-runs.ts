// SPDX-License-Identifier: Apache-2.0
import type { Pool } from "pg";
import type { EventStore, RunSummary } from "@rovinos/store/adapter-internal";
import { watchRunSummaries } from "@rovinos/store/adapter-internal";
import { runListPage, storeError, type RunSummaryRow } from "./helpers.js";
import type { PostgresSubscriptions } from "./subscriptions.js";

interface WatchPostgresRunsInput {
  readonly store: EventStore;
  readonly options: Parameters<EventStore["watchRuns"]>[0];
  readonly pool: Pool;
  readonly subscriptions: PostgresSubscriptions;
  readonly ensureInitialized: () => Promise<void>;
}

/** Watch persisted run summaries using the store's Postgres notification subscription. */
export function watchPostgresRuns({
  store,
  options,
  pool,
  subscriptions,
  ensureInitialized,
}: WatchPostgresRunsInput): AsyncIterable<RunSummary> {
  return watchRunSummaries(
    store,
    options,
    (runId, signal) => subscriptions.subscribe(runId, signal),
    async (runId) => {
      try {
        await ensureInitialized();
        const result = await pool.query<RunSummaryRow>(
          "SELECT run_id, created_at, status, next_seq - 1 AS last_seq, last_ts FROM runs WHERE run_id = $1",
          [runId],
        );
        const row = result.rows[0];
        return row === undefined ? undefined : runListPage([row], 1).runs[0];
      } catch (error) {
        throw storeError(error);
      }
    },
  );
}
