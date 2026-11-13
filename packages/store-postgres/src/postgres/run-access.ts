// SPDX-License-Identifier: Apache-2.0
import { Code, Id } from "@rovinos/schemas";
import type { Event, TraceId, Code as SinkId } from "@rovinos/schemas";
import type { Pool, QueryResultRow } from "pg";
import {
  decodeSnapshot,
  InvalidEventError,
  StoreUnavailableError,
  type Clock,
  type ContentCodec,
  type EventStore,
  type ListRunsOptions,
  type RunSummary,
  type SnapshotRow,
} from "@rovinos/store/adapter-internal";
import { integer, eventFromRow, storeError, type EventRow } from "./helpers.js";
import { deleteRunTransaction } from "./retention.js";
import { findPostgresRunsByTrace, listPostgresRuns } from "./run-listing.js";
import { readEvents } from "./reader.js";
import { isRunTerminal, type PostgresSubscriptions } from "./subscriptions.js";
import { watchEvents } from "@rovinos/store/adapter-internal";
import { watchPostgresRuns } from "./watch-runs.js";

interface PostgresRunAccessOptions {
  readonly pool: Pool;
  readonly codec: ContentCodec;
  readonly clock: Clock;
  readonly ensureInitialized: () => Promise<void>;
  readonly assertWritable: () => void;
  readonly store: EventStore;
  readonly subscriptions: PostgresSubscriptions;
}

/** Access methods for runs, snapshots, execution leases, and the event outbox. */
export class PostgresRunAccess {
  private readonly pool: Pool;
  private readonly codec: ContentCodec;
  private readonly clock: Clock;
  private readonly ensureInitialized: () => Promise<void>;
  private readonly assertWritable: () => void;
  private readonly store: EventStore;
  private readonly subscriptions: PostgresSubscriptions;

  constructor(options: PostgresRunAccessOptions) {
    this.pool = options.pool;
    this.codec = options.codec;
    this.clock = options.clock;
    this.ensureInitialized = options.ensureInitialized;
    this.assertWritable = options.assertWritable;
    this.store = options.store;
    this.subscriptions = options.subscriptions;
  }

  async claimRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    this.assertWritable();
    await this.ensureInitialized();
    const result = await this.pool.query(
      "INSERT INTO run_execution_leases (run_id, owner_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (run_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, expires_at = EXCLUDED.expires_at WHERE run_execution_leases.expires_at <= $4 RETURNING owner_id",
      [runId, owner, now + leaseMs, now],
    );
    return result.rows.length === 1;
  }

  async renewRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    this.assertWritable();
    await this.ensureInitialized();
    const result = await this.pool.query(
      "UPDATE run_execution_leases SET expires_at = $1 WHERE run_id = $2 AND owner_id = $3 AND expires_at > $4 RETURNING owner_id",
      [now + leaseMs, runId, owner, now],
    );
    return result.rows.length === 1;
  }

  async releaseRunExecution(runId: Id, owner: Id): Promise<void> {
    this.assertWritable();
    await this.ensureInitialized();
    await this.pool.query("DELETE FROM run_execution_leases WHERE run_id = $1 AND owner_id = $2", [
      runId,
      owner,
    ]);
  }

  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<Event> {
    return readEvents(
      { pool: this.pool, codec: this.codec, ensureInitialized: () => this.ensureInitialized() },
      runId,
      range,
    );
  }

  watch(runId: Id, options: Parameters<EventStore["watch"]>[1]): AsyncIterable<Event> {
    return watchEvents(this.store, runId, options, {
      subscribe: (watchedRunId, signal) => this.subscriptions.subscribe(watchedRunId, signal),
      isTerminal: (watchedRunId, observedNextSeq) =>
        isRunTerminal(this.pool, () => this.ensureInitialized(), watchedRunId, observedNextSeq),
    });
  }

  watchRuns(options: Parameters<EventStore["watchRuns"]>[0]): AsyncIterable<RunSummary> {
    return watchPostgresRuns({
      store: this.store,
      options,
      pool: this.pool,
      subscriptions: this.subscriptions,
      ensureInitialized: () => this.ensureInitialized(),
    });
  }

  async head(runId: Id): Promise<number> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<{ next_seq: number | string }>(
        "SELECT next_seq FROM runs WHERE run_id = $1",
        [runId],
      );
      const row = result.rows[0];
      return row === undefined ? 0 : integer(row.next_seq);
    } catch (error) {
      throw storeError(error);
    }
  }

  async deleteRun(runId: Id): Promise<number> {
    this.assertWritable();
    try {
      await this.ensureInitialized();
      const client = await this.pool.connect();
      try {
        return await deleteRunTransaction(client, runId);
      } finally {
        client.release();
      }
    } catch (error) {
      throw storeError(error);
    }
  }

  async latestSnapshot(runId: Id): Promise<Awaited<ReturnType<EventStore["latestSnapshot"]>>> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<SnapshotRow & QueryResultRow>(
        "SELECT snapshot_id, run_id, at_seq, created_at, meta_json, content_blob, key_id FROM snapshots WHERE run_id = $1 ORDER BY at_seq DESC, snapshot_id DESC LIMIT 1",
        [runId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : await decodeSnapshot(this.codec, row);
    } catch (error) {
      throw storeError(error);
    }
  }

  async retainedSnapshots(
    runId: Id,
    limit: number,
  ): Promise<Awaited<ReturnType<EventStore["retainedSnapshots"]>>> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("Snapshot limit must be a positive integer");
    }
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<SnapshotRow & QueryResultRow>(
        "SELECT snapshot_id, run_id, at_seq, created_at, meta_json, content_blob, key_id FROM snapshots WHERE run_id = $1 ORDER BY at_seq DESC, snapshot_id DESC LIMIT $2",
        [runId, limit],
      );
      return await Promise.all(result.rows.map((row) => decodeSnapshot(this.codec, row)));
    } catch (error) {
      throw storeError(error);
    }
  }

  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    return listPostgresRuns(this.pool, () => this.ensureInitialized(), opts);
  }

  findRunsByTrace(traceId: TraceId): Promise<Id[]> {
    return findPostgresRunsByTrace(this.pool, () => this.ensureInitialized(), traceId);
  }

  async fetchOutbox(sinkId: SinkId, limit: number): Promise<{ events: Event[]; cursor: number }> {
    const parsedSinkId = Code.safeParse(sinkId);
    if (!parsedSinkId.success) {
      throw new InvalidEventError([["sinkId"]]);
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new InvalidEventError([["limit"]]);
    }
    try {
      await this.ensureInitialized();
      const cursorResult = await this.pool.query<{ cursor: number | string }>(
        "SELECT cursor FROM sink_cursors WHERE sink_id = $1",
        [parsedSinkId.data],
      );
      const lastAcked =
        cursorResult.rows[0] === undefined ? 0 : integer(cursorResult.rows[0].cursor);
      const result = await this.pool.query<EventRow & { global_seq: number | string }>(
        "SELECT global_seq, run_id, seq, ts, type, trace_id, span_id, segment_id, meta, content_blob, key_id FROM events WHERE global_seq > $1 AND tx_id < pg_snapshot_xmin(pg_current_snapshot()) ORDER BY global_seq LIMIT $2",
        [lastAcked, limit],
      );
      const events: Event[] = [];
      for (const row of result.rows) {
        const runId = Id.safeParse(row.run_id);
        if (!runId.success) {
          throw new StoreUnavailableError();
        }
        events.push(await eventFromRow(this.codec, runId.data, row));
      }
      const last = result.rows.at(-1);
      return {
        events,
        cursor: last === undefined ? lastAcked : integer(last.global_seq),
      };
    } catch (error) {
      throw storeError(error);
    }
  }

  async ackOutbox(sinkId: SinkId, cursor: number): Promise<void> {
    const parsedSinkId = Code.safeParse(sinkId);
    if (!parsedSinkId.success) {
      throw new InvalidEventError([["sinkId"]]);
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new InvalidEventError([["cursor"]]);
    }
    this.assertWritable();
    try {
      await this.ensureInitialized();
      await this.pool.query(
        "INSERT INTO sink_cursors (sink_id, cursor, updated_at) VALUES ($1, $2, $3) ON CONFLICT (sink_id) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at WHERE sink_cursors.cursor < EXCLUDED.cursor",
        [parsedSinkId.data, cursor, this.clock.now()],
      );
    } catch (error) {
      throw storeError(error);
    }
  }
}
