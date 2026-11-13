// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { Event as StoredEvent, Id, Snapshot, TraceId } from "@rovinos/schemas";
import {
  decodeSnapshot,
  type ContentCodec,
  type ListRunsOptions,
  type RunSummary,
  type SnapshotRow,
} from "@rovinos/store/adapter-internal";
import { sqliteStoreError } from "./outbox.js";
import {
  decodeStoredContent,
  eventFromRow,
  parseStoredMeta,
  type EventRow,
  type RunSummaryRow,
} from "./serialization.js";
import { listSqliteRuns, prepareListRunsQuery, type ListRunsQueryParams } from "./run-listing.js";
import { findRunsByTrace } from "./traces.js";

const READ_PAGE_SIZE = 256;

interface SqliteReadOperationsOptions {
  readonly db: Database.Database;
  readonly codec: ContentCodec;
}

/** Read-side queries and decoding for one SQLite event store. */
export class SqliteReadOperations {
  private readonly db: Database.Database;
  private readonly codec: ContentCodec;
  private readonly readEvents: Database.Statement<
    [Id, number, number | null, number | null, number],
    EventRow
  >;
  private readonly getHead: Database.Statement<[Id], { readonly next_seq: number }>;
  private readonly findRunsByTraceQuery: Database.Statement<[TraceId], { readonly run_id: string }>;
  private readonly listRunsQuery: Database.Statement<ListRunsQueryParams, RunSummaryRow>;
  private readonly latestSnapshotQuery: Database.Statement<[Id], SnapshotRow>;
  private readonly retainedSnapshotsQuery: Database.Statement<[Id, number], SnapshotRow>;

  constructor(options: SqliteReadOperationsOptions) {
    this.db = options.db;
    this.codec = options.codec;
    this.readEvents = this.db.prepare<[Id, number, number | null, number | null, number], EventRow>(
      "SELECT run_id, seq, ts, type, trace_id, span_id, segment_id, meta_json, content_blob, key_id FROM events WHERE run_id = ? AND seq >= ? AND (? IS NULL OR seq <= ?) ORDER BY seq LIMIT ?",
    );
    this.getHead = this.db.prepare<[Id], { readonly next_seq: number }>(
      "SELECT next_seq FROM runs WHERE run_id = ?",
    );
    this.findRunsByTraceQuery = this.db.prepare<[TraceId], { readonly run_id: string }>(
      "SELECT run_id FROM events WHERE trace_id = ? GROUP BY run_id ORDER BY MIN(global_seq)",
    );
    this.listRunsQuery = prepareListRunsQuery(this.db);
    this.latestSnapshotQuery = this.db.prepare<[Id], SnapshotRow>(
      "SELECT snapshot_id, run_id, at_seq, created_at, meta_json, content_blob, key_id FROM snapshots WHERE run_id = ? ORDER BY at_seq DESC, snapshot_id DESC LIMIT 1",
    );
    this.retainedSnapshotsQuery = this.db.prepare<[Id, number], SnapshotRow>(
      "SELECT snapshot_id, run_id, at_seq, created_at, meta_json, content_blob, key_id FROM snapshots WHERE run_id = ? ORDER BY at_seq DESC, snapshot_id DESC LIMIT ?",
    );
  }

  async *read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<StoredEvent> {
    const fromSeq = range?.fromSeq ?? 0;
    const toSeq = range?.toSeq ?? null;
    let nextSeq = fromSeq;
    try {
      let rows = this.readEvents.all(runId, nextSeq, toSeq, toSeq, READ_PAGE_SIZE);
      while (rows.length !== 0) {
        for (const row of rows) {
          const storedMeta = parseStoredMeta(row.meta_json);
          const content = await decodeStoredContent(this.codec, runId, row);
          yield eventFromRow(row, storedMeta, content);
          nextSeq = row.seq + 1;
        }
        rows = this.readEvents.all(runId, nextSeq, toSeq, toSeq, READ_PAGE_SIZE);
      }
    } catch (error) {
      throw sqliteStoreError(error);
    }
  }

  head(runId: Id): Promise<number> {
    try {
      const row = this.getHead.get(runId);
      return Promise.resolve(row?.next_seq ?? 0);
    } catch (error) {
      return Promise.reject(sqliteStoreError(error));
    }
  }

  async latestSnapshot(runId: Id): Promise<Snapshot | undefined> {
    try {
      const row = this.latestSnapshotQuery.get(runId);
      return row === undefined ? undefined : await decodeSnapshot(this.codec, row);
    } catch (error) {
      throw sqliteStoreError(error);
    }
  }

  async retainedSnapshots(runId: Id, limit: number): Promise<Snapshot[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("Snapshot limit must be a positive integer");
    }
    try {
      return await Promise.all(
        this.retainedSnapshotsQuery.all(runId, limit).map((row) => decodeSnapshot(this.codec, row)),
      );
    } catch (error) {
      throw sqliteStoreError(error);
    }
  }

  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    return listSqliteRuns(this.listRunsQuery, opts);
  }

  findRunsByTrace(traceId: TraceId): Promise<Id[]> {
    return findRunsByTrace(this.findRunsByTraceQuery, traceId);
  }
}
