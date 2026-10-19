// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import {
  RunStatus,
  type Id,
  type TraceId,
  type Event as StoredEvent,
  type NewEvent,
  type Snapshot,
} from "@harness/schemas";
import {
  JsonContentCodec,
  decodeSnapshot,
  encodeSnapshot,
  snapshotKeep,
  validateSnapshotAppend,
  type ContentCodec,
  type EncodedSnapshot,
  type SnapshotRow,
} from "../codec.js";
import {
  InvalidEventError,
  RunExecutionLeaseLostError,
  SeqConflictError,
  StoreMigrationError,
} from "../errors.js";
import {
  systemClock,
  sqliteStoreOptionsSchema,
  type Clock,
  type EventStore,
  type IdempotencyKeyHash,
  type IdempotencyKeyTakeoverOptions,
  type ListRunsOptions,
  type RunSummary,
  type SqliteStoreOptions,
} from "../types.js";
import {
  ChangeEmitter,
  waitForChangeWithPolling,
  watchEvents,
  watchRunSummaries,
  type ChangeSubscription,
} from "../subscriptions.js";
import { SqliteOutboxReader, sqliteStoreError as storeError } from "./outbox.js";
import {
  claimSqliteIdempotencyKey,
  releaseSqliteIdempotencyKey,
  takeoverSqliteIdempotencyKey,
} from "./idempotency.js";
import { migrate } from "../migrate.js";
import {
  decodeStoredContent,
  eventFromRow,
  initializeEncryptionMetadata,
  validateEncryptionMetadata,
  insertSnapshot,
  parseStoredMeta,
  prepareRunSummaryQuery,
  readRunSummary,
  type EventRow,
  type RunRow,
  type RunSummaryRow,
} from "./serialization.js";
import { openReadOnlyDatabase } from "./read-only.js";
import { deleteRunTransaction } from "./retention.js";
import { SqliteApprovalNotifications } from "./approval-notifications.js";
import { SqliteConfirmationStates } from "./confirmation-states.js";
import { findRunsByTrace } from "./traces.js";
import { encodeEvents, type EncodedEvent } from "./event-encoding.js";
import type { StoreKeyRotation } from "../rotate.js";
import { countSqliteRowsByKey, reencryptSqliteBatch } from "./rotation.js";
import { listSqliteRuns, prepareListRunsQuery, type ListRunsQueryParams } from "./run-listing.js";

const READ_PAGE_SIZE = 256;

/** Durable SQLite implementation of the append-only event store. */
export class SqliteEventStore implements EventStore, StoreKeyRotation {
  private readonly db: Database.Database;
  private readonly codec: ContentCodec;
  private readonly insertRun: Database.Statement<[Id, number, number]>;
  private readonly getRun: Database.Statement<[Id], RunRow>;
  private readonly getRunSummary: Database.Statement<[Id], RunSummaryRow>;
  private readonly insertEvent: Database.Statement<
    [Id, number, number, string, string, string, string, string, string, string | null]
  >;
  private readonly updateRun: Database.Statement<[number, RunStatus, number, Id]>;
  private readonly readEvents: Database.Statement<
    [Id, number, number | null, number | null, number],
    EventRow
  >;
  private readonly getHead: Database.Statement<[Id], { next_seq: number }>;
  private readonly findRunsByTraceQuery: Database.Statement<[TraceId], { run_id: string }>;
  private readonly listRunsQuery: Database.Statement<ListRunsQueryParams, RunSummaryRow>;
  private readonly insertSnapshot: Database.Statement<
    [string, Id, number, number, string, string, string | null]
  >;
  private readonly pruneSnapshots: Database.Statement<[Id, Id, number]>;
  private readonly latestSnapshotQuery: Database.Statement<[Id], SnapshotRow>;
  private readonly retainedSnapshotsQuery: Database.Statement<[Id, number], SnapshotRow>;
  private readonly snapshotKeep: number;
  private readonly pollIntervalMs: number;
  private readonly changeEmitter = new ChangeEmitter();
  private readonly outbox: SqliteOutboxReader;
  private readonly approvalNotifications: SqliteApprovalNotifications;
  private readonly confirmationStates: SqliteConfirmationStates;

  /**
   * Open a SQLite database and initialize its initial schema.
   *
   * @param path Database file path or `:memory:`.
   * @param codec Codec used to store content separately from event metadata.
   * @param options Snapshot retention, read-only mode, and external-writer polling interval.
   * @param clock Clock supplying timestamps for sink-cursor updates.
   */
  constructor(
    path: string,
    codec: ContentCodec = new JsonContentCodec(),
    options: SqliteStoreOptions = {},
    clock: Clock = systemClock,
  ) {
    const parsedOptions = sqliteStoreOptionsSchema.parse(options);
    this.db = parsedOptions.readOnly ? openReadOnlyDatabase(path) : new Database(path);
    this.codec = codec;
    this.snapshotKeep = snapshotKeep({ snapshotKeep: parsedOptions.snapshotKeep });
    this.pollIntervalMs = parsedOptions.pollIntervalMs;
    try {
      if (!parsedOptions.readOnly) {
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        migrate(this.db, "sqlite", { appliedAt: clock.now() });
        initializeEncryptionMetadata(this.db, this.codec.encrypted);
      } else {
        if (migrate(this.db, "sqlite", { dryRun: true }).length > 0) {
          throw new StoreMigrationError("schema_migration_pending");
        }
        validateEncryptionMetadata(this.db, this.codec.encrypted);
      }
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("foreign_keys = ON");
      this.outbox = new SqliteOutboxReader(this.db, this.codec, clock);
      this.approvalNotifications = new SqliteApprovalNotifications(this.db);
      this.confirmationStates = new SqliteConfirmationStates(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }

    this.insertRun = this.db.prepare<[Id, number, number]>(
      "INSERT INTO runs (run_id, created_at, status, next_seq, last_ts) VALUES (?, ?, 'pending', 0, ?)",
    );
    this.getRun = this.db.prepare<[Id], RunRow>(
      "SELECT next_seq, status FROM runs WHERE run_id = ?",
    );
    this.getRunSummary = prepareRunSummaryQuery(this.db);
    this.insertEvent = this.db.prepare<
      [Id, number, number, string, string, string, string, string, string, string | null]
    >(
      "INSERT INTO events (run_id, seq, ts, type, trace_id, span_id, segment_id, meta_json, content_blob, key_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.updateRun = this.db.prepare<[number, RunStatus, number, Id]>(
      "UPDATE runs SET next_seq = ?, status = ?, last_ts = ? WHERE run_id = ?",
    );
    this.readEvents = this.db.prepare<[Id, number, number | null, number | null, number], EventRow>(
      "SELECT run_id, seq, ts, type, trace_id, span_id, segment_id, meta_json, content_blob, key_id FROM events WHERE run_id = ? AND seq >= ? AND (? IS NULL OR seq <= ?) ORDER BY seq LIMIT ?",
    );
    this.getHead = this.db.prepare<[Id], { next_seq: number }>(
      "SELECT next_seq FROM runs WHERE run_id = ?",
    );
    this.findRunsByTraceQuery = this.db.prepare<[TraceId], { run_id: string }>(
      "SELECT run_id FROM events WHERE trace_id = ? GROUP BY run_id ORDER BY MIN(global_seq)",
    );
    this.listRunsQuery = prepareListRunsQuery(this.db);
    this.insertSnapshot = this.db.prepare<
      [string, Id, number, number, string, string, string | null]
    >(
      "INSERT INTO snapshots (snapshot_id, run_id, at_seq, created_at, meta_json, content_blob, key_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.pruneSnapshots = this.db.prepare<[Id, Id, number]>(
      "DELETE FROM snapshots WHERE run_id = ? AND snapshot_id NOT IN (SELECT snapshot_id FROM snapshots WHERE run_id = ? ORDER BY at_seq DESC, snapshot_id DESC LIMIT ?)",
    );
    this.latestSnapshotQuery = this.db.prepare<[Id], SnapshotRow>(
      "SELECT snapshot_id, run_id, at_seq, created_at, meta_json, content_blob, key_id FROM snapshots WHERE run_id = ? ORDER BY at_seq DESC, snapshot_id DESC LIMIT 1",
    );
    this.retainedSnapshotsQuery = this.db.prepare<[Id, number], SnapshotRow>(
      "SELECT snapshot_id, run_id, at_seq, created_at, meta_json, content_blob, key_id FROM snapshots WHERE run_id = ? ORDER BY at_seq DESC, snapshot_id DESC LIMIT ?",
    );
  }

  /** {@inheritDoc StoreKeyRotation.reencryptBatch} */
  reencryptBatch: StoreKeyRotation["reencryptBatch"] = (input) =>
    reencryptSqliteBatch(this.db, this.codec, input);

  /** Count event and snapshot rows that still use each key. */
  countRowsByKey: StoreKeyRotation["countRowsByKey"] = () => countSqliteRowsByKey(this.db);

  /** {@inheritDoc EventStore.append} */
  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    const encoded = await encodeEvents(this.codec, runId, events, expectedSeq);
    return this.writeAppend(runId, encoded, expectedSeq, undefined, leaseOwner);
  }

  /** {@inheritDoc EventStore.appendWithSnapshot} */
  async appendWithSnapshot(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Snapshot,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    const validatedSnapshot = validateSnapshotAppend(runId, events, expectedSeq, snapshot);
    const [encoded, encodedSnapshot] = await Promise.all([
      encodeEvents(this.codec, runId, events, expectedSeq),
      encodeSnapshot(this.codec, validatedSnapshot),
    ]);
    return this.writeAppend(runId, encoded, expectedSeq, encodedSnapshot, leaseOwner);
  }

  /** {@inheritDoc EventStore.claimRunExecution} */
  claimRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    const result = this.db
      .prepare<
        [Id, Id, number, number],
        { changes: number }
      >(
        "INSERT INTO run_execution_leases (run_id, owner_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at WHERE run_execution_leases.expires_at <= ?",
      )
      .run(runId, owner, now + leaseMs, now);
    return Promise.resolve(result.changes === 1);
  }

  /** {@inheritDoc EventStore.renewRunExecution} */
  renewRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    const result = this.db
      .prepare<[number, Id, Id, number], { changes: number }>(
        "UPDATE run_execution_leases SET expires_at = ? WHERE run_id = ? AND owner_id = ? AND expires_at > ?",
      )
      .run(now + leaseMs, runId, owner, now);
    return Promise.resolve(result.changes === 1);
  }

  /** {@inheritDoc EventStore.releaseRunExecution} */
  releaseRunExecution(runId: Id, owner: Id): Promise<void> {
    this.db
      .prepare<[Id, Id]>("DELETE FROM run_execution_leases WHERE run_id = ? AND owner_id = ?")
      .run(runId, owner);
    return Promise.resolve();
  }

  private writeAppend(
    runId: Id,
    encoded: readonly EncodedEvent[],
    expectedSeq: number,
    encodedSnapshot?: EncodedSnapshot,
    leaseOwner?: Id,
  ): { nextSeq: number } {
    const validated = encoded.map(({ event }) => event);

    try {
      const appendTransaction = this.db.transaction(() => {
        if (leaseOwner !== undefined) {
          const lease = this.db
            .prepare<[Id], { owner_id: Id }>(
              "SELECT owner_id FROM run_execution_leases WHERE run_id = ?",
            )
            .get(runId);
          if (lease?.owner_id !== leaseOwner) {
            throw new RunExecutionLeaseLostError();
          }
        }
        const existingRun = this.getRun.get(runId);
        const actualSeq = existingRun?.next_seq ?? 0;
        if (actualSeq !== expectedSeq) {
          throw new SeqConflictError(expectedSeq, actualSeq);
        }

        const first = validated[0];
        const last = validated.at(-1);
        if (first === undefined || last === undefined) {
          throw new InvalidEventError([[]]);
        }
        if (existingRun === undefined) {
          if (first.type !== "run_created") {
            throw new InvalidEventError([[0, "type"]]);
          }
          this.insertRun.run(runId, first.ts, first.ts);
        }

        for (const { event, metaJson, blob, keyId } of encoded) {
          this.insertEvent.run(
            runId,
            event.seq,
            event.ts,
            event.type,
            event.traceId,
            event.spanId,
            event.segmentId,
            metaJson,
            blob,
            keyId,
          );
        }

        const currentStatus = RunStatus.safeParse(existingRun?.status ?? "pending");
        if (!currentStatus.success) {
          throw new InvalidEventError([["status"]]);
        }
        let status = currentStatus.data;
        for (const event of validated) {
          if (event.type === "run_status_changed") {
            status = event.to;
          }
        }
        this.updateRun.run(expectedSeq + validated.length, status, last.ts, runId);
        if (encodedSnapshot !== undefined) {
          insertSnapshot(this.insertSnapshot, encodedSnapshot);
          this.pruneSnapshots.run(runId, runId, this.snapshotKeep);
        }
      });
      appendTransaction.immediate();
      this.changeEmitter.notify(runId);
      return { nextSeq: expectedSeq + validated.length };
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.read} */
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
      throw storeError(error);
    }
  }

  private waitForChange(runId: Id | undefined, signal: AbortSignal): ChangeSubscription {
    return waitForChangeWithPolling(this.changeEmitter, runId, signal, this.pollIntervalMs);
  }

  /** {@inheritDoc EventStore.watch} */
  watch(runId: Id, options: Parameters<EventStore["watch"]>[1]): AsyncIterable<StoredEvent> {
    return watchEvents(this, runId, options, {
      subscribe: (watchedRunId, signal) => this.waitForChange(watchedRunId, signal),
      isTerminal: (watchedRunId, observedNextSeq) => {
        const current = this.getRun.get(watchedRunId);
        return Promise.resolve(
          current !== undefined &&
            current.next_seq <= observedNextSeq &&
            (current.status === "completed" ||
              current.status === "failed" ||
              current.status === "cancelled"),
        );
      },
    });
  }

  /** {@inheritDoc EventStore.watchRuns} */
  watchRuns(options: Parameters<EventStore["watchRuns"]>[0]): AsyncIterable<RunSummary> {
    return watchRunSummaries(
      this,
      options,
      (runId, signal) => this.waitForChange(runId, signal),
      (runId) => Promise.resolve(readRunSummary(this.getRunSummary, runId)),
    );
  }

  /** {@inheritDoc EventStore.head} */
  head(runId: Id): Promise<number> {
    try {
      const row = this.getHead.get(runId);
      return Promise.resolve(row?.next_seq ?? 0);
    } catch (error) {
      return Promise.reject(storeError(error));
    }
  }

  /** {@inheritDoc EventStore.claimIdempotencyKey} */
  claimIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id, createdAt: number): Promise<Id> {
    return claimSqliteIdempotencyKey(this.db, keyHash, runId, createdAt);
  }

  /** {@inheritDoc EventStore.takeoverIdempotencyKey} */
  takeoverIdempotencyKey(
    keyHash: IdempotencyKeyHash,
    options: IdempotencyKeyTakeoverOptions,
  ): Promise<boolean> {
    return takeoverSqliteIdempotencyKey(this.db, keyHash, options);
  }

  /** {@inheritDoc EventStore.releaseIdempotencyKey} */
  releaseIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id): Promise<void> {
    return releaseSqliteIdempotencyKey(this.db, keyHash, runId);
  }

  /** {@inheritDoc EventStore.deleteRun} */
  deleteRun(runId: Id): Promise<number> {
    try {
      return Promise.resolve(deleteRunTransaction(this.db, runId));
    } catch (error) {
      return Promise.reject(storeError(error));
    }
  }

  /** {@inheritDoc EventStore.latestSnapshot} */
  async latestSnapshot(runId: Id): Promise<Snapshot | undefined> {
    try {
      const row = this.latestSnapshotQuery.get(runId);
      return row === undefined ? undefined : await decodeSnapshot(this.codec, row);
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.retainedSnapshots} */
  async retainedSnapshots(runId: Id, limit: number): Promise<Snapshot[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("Snapshot limit must be a positive integer");
    }
    try {
      return await Promise.all(
        this.retainedSnapshotsQuery.all(runId, limit).map((row) => decodeSnapshot(this.codec, row)),
      );
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.listRuns} */
  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    return listSqliteRuns(this.listRunsQuery, opts);
  }

  /** {@inheritDoc EventStore.findRunsByTrace} */
  findRunsByTrace: EventStore["findRunsByTrace"] = (traceId) =>
    findRunsByTrace(this.findRunsByTraceQuery, traceId);

  /** {@inheritDoc EventStore.fetchOutbox} */
  fetchOutbox: EventStore["fetchOutbox"] = (sinkId, limit) => this.outbox.fetch(sinkId, limit);

  /** {@inheritDoc EventStore.ackOutbox} */
  ackOutbox: EventStore["ackOutbox"] = (sinkId, cursor) => this.outbox.ack(sinkId, cursor);

  claimApprovalNotification: EventStore["claimApprovalNotification"] = (...args) =>
    this.approvalNotifications.claim(...args);
  markApprovalNotificationSent: EventStore["markApprovalNotificationSent"] = (...args) =>
    this.approvalNotifications.markSent(...args);
  releaseApprovalNotification: EventStore["releaseApprovalNotification"] = (...args) =>
    this.approvalNotifications.release(...args);
  consumeConfirmationState: EventStore["consumeConfirmationState"] = (...args) =>
    this.confirmationStates.consume(...args);

  /** {@inheritDoc EventStore.close} */
  close(): Promise<void> {
    try {
      this.db.close();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(storeError(error));
    }
  }
}
