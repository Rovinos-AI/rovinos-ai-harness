// SPDX-License-Identifier: Apache-2.0
import { Id, TraceId } from "@rovinos/schemas";
import { InvalidEventError } from "@rovinos/store/adapter-internal";
import type { ListRunsOptions, RunSummary } from "@rovinos/store/adapter-internal";
import { decodeCursor, runListPage, storeError, type RunSummaryRow } from "./helpers.js";
import type { Pool } from "pg";

/**
 * List Postgres run summaries with keyset pagination.
 * @param pool Connection pool for the target schema.
 * @param initialize Initialize and migrate the store schema.
 * @param opts Listing filters and pagination options.
 * @returns The requested run page.
 */
export async function listPostgresRuns(
  pool: Pool,
  initialize: () => Promise<void>,
  opts: ListRunsOptions,
): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    throw new InvalidEventError([["limit"]]);
  }
  try {
    await initialize();
    const cursor = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor);
    const result = await pool.query<RunSummaryRow>(
      `SELECT runs.run_id, runs.created_at, runs.status, runs.next_seq - 1 AS last_seq, runs.last_ts
      FROM runs
      WHERE ($1::text IS NULL OR runs.run_id IN (
        SELECT run_id FROM events
        WHERE type = 'run_created' AND meta ->> 'continuationOf' = $1
      ))
      AND ($2::text IS NULL OR runs.status = $2)
      AND ($3::bigint IS NULL OR runs.created_at < $3 OR (runs.created_at = $3 AND runs.run_id > $4))
      ORDER BY runs.created_at DESC, runs.run_id ASC
      LIMIT $5`,
      [
        opts.continuationOf ?? null,
        opts.status ?? null,
        cursor?.createdAt ?? null,
        cursor?.runId ?? null,
        opts.limit + 1,
      ],
    );
    return runListPage(result.rows, opts.limit);
  } catch (error) {
    throw storeError(error);
  }
}

/**
 * Find runs whose event log contains the trace id.
 * @param pool Connection pool for the target schema.
 * @param initialize Initialize and migrate the store schema.
 * @param traceId Trace identifier to find.
 * @returns Run ids ordered by first appearance.
 */
export async function findPostgresRunsByTrace(
  pool: Pool,
  initialize: () => Promise<void>,
  traceId: TraceId,
): Promise<Id[]> {
  const parsedTraceId = TraceId.safeParse(traceId);
  if (!parsedTraceId.success) {
    throw new InvalidEventError([["traceId"]]);
  }
  try {
    await initialize();
    const result = await pool.query<{ run_id: string }>(
      "SELECT run_id FROM events WHERE trace_id = $1 GROUP BY run_id ORDER BY MIN(global_seq)",
      [parsedTraceId.data],
    );
    return result.rows.map(({ run_id }) => Id.parse(run_id));
  } catch (error) {
    throw storeError(error);
  }
}
