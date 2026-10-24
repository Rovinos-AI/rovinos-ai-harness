// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { Id, parseJson, type RunStatus } from "@rovinos/schemas";
import { z } from "zod";
import { InvalidEventError } from "@rovinos/store/adapter-internal";
import type { ListRunsOptions, RunSummary } from "@rovinos/store/adapter-internal";
import { sqliteStoreError } from "./outbox.js";
import { runListPage, type RunSummaryRow } from "./serialization.js";

const runCursorSchema = z.tuple([z.number().int().nonnegative(), Id]);

/** Bind parameters for the prepared SQLite run-list query. */
export type ListRunsQueryParams = [
  Id | null,
  Id | null,
  RunStatus | null,
  RunStatus | null,
  number | null,
  number | null,
  number | null,
  Id | null,
  number,
];

/**
 * Prepare the SQLite run-list query.
 * @param db Database connection for the target store.
 * @returns The parameterized run-list query.
 */
export function prepareListRunsQuery(
  db: Database.Database,
): Database.Statement<ListRunsQueryParams, RunSummaryRow> {
  return db.prepare<ListRunsQueryParams, RunSummaryRow>(`
    SELECT runs.run_id, runs.created_at, runs.status, runs.next_seq - 1 AS last_seq, runs.last_ts
    FROM runs
    WHERE (? IS NULL OR runs.run_id IN (
      SELECT run_id FROM events
      WHERE type = 'run_created' AND json_extract(meta_json, '$.continuationOf') = ?
    ))
    AND (? IS NULL OR runs.status = ?)
    AND (? IS NULL OR runs.created_at < ? OR (runs.created_at = ? AND runs.run_id > ?))
    ORDER BY runs.created_at DESC, runs.run_id ASC
    LIMIT ?
  `);
}

function decodeCursor(cursor: string): { createdAt: number; runId: Id } {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [createdAt, runId] = parseJson(runCursorSchema, decoded);
    return { createdAt, runId };
  } catch {
    throw new InvalidEventError([["cursor"]]);
  }
}

function continuationRunParams(continuationOf: Id | undefined): [Id | null, Id | null] {
  const runId = continuationOf ?? null;
  return [runId, runId];
}

/**
 * List SQLite run summaries with keyset pagination.
 * @param query Prepared run-list query.
 * @param opts Listing filters and pagination options.
 * @returns The requested run page.
 */
export function listSqliteRuns(
  query: Database.Statement<ListRunsQueryParams, RunSummaryRow>,
  opts: ListRunsOptions,
): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    return Promise.reject(new InvalidEventError([["limit"]]));
  }
  try {
    const cursor = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor);
    const continuationParams = continuationRunParams(opts.continuationOf);
    const rows = query.all(
      ...continuationParams,
      opts.status ?? null,
      opts.status ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.runId ?? null,
      opts.limit + 1,
    );
    return Promise.resolve(runListPage(rows, opts.limit));
  } catch (error) {
    return Promise.reject(sqliteStoreError(error));
  }
}
