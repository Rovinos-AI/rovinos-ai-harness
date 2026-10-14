// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import {
  Id,
  RunStatus,
  parseJson,
  type TraceId,
  type Event as StoredEvent,
  type NewEvent,
  type Snapshot,
} from "@harness/schemas";
import { z } from "zod";
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
  ContentDecryptFailedError,
  ContentEncryptFailedError,
  InvalidEventError,
  KeyNotFoundError,
  SeqConflictError,
  StoreMigrationError,
  StoreUnavailableError,
} from "../errors.js";
import {
  systemClock,
  sqliteStoreOptionsSchema,
  type Clock,
  type EventStore,
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
  runListPage,
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
import {
  decodeStoreRotationCursor,
  encodeStoreRotationCursor,
  ReencryptBatchInputSchema,
  StoreKeyRowCountSchema,
  StoreReencryptBatchResultSchema,
  type ReencryptBatchInput,
  type StoreKeyRotation,
  type StoreRotationCursor,
} from "../rotate.js";
const runCursorSchema = z.tuple([z.number().int().nonnegative(), Id]);
const READ_PAGE_SIZE = 256;

interface StoreRotationEventRow {
  global_seq: number;
  run_id: string;
  seq: number;
  content_blob: string;
  key_id: string;
}

interface StoreRotationSnapshotRow {
  snapshot_id: string;
  run_id: string;
  at_seq: number;
  content_blob: string;
  key_id: string;
}

type StoreRotationUpdate =
  | {
      readonly table: "events";
      readonly globalSeq: number;
      readonly runId: Id;
      readonly seq: number;
      readonly blob: string;
      readonly oldBlob: string;
      readonly oldKeyId: string;
    }
  | {
      readonly table: "snapshots";
      readonly snapshotId: string;
      readonly runId: Id;
      readonly seq: number;
      readonly blob: string;
      readonly oldBlob: string;
      readonly oldKeyId: string;
    };

type ListRunsQueryParams = [
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

function decodeCursor(cursor: string): { createdAt: number; runId: Id } {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [createdAt, runId] = parseJson(runCursorSchema, decoded);
    return { createdAt, runId };
  } catch {
    throw new InvalidEventError([["cursor"]]);
  }
}

function prepareListRunsQuery(
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

function continuationRunParams(continuationOf: Id | undefined): [Id | null, Id | null] {
  const runId = continuationOf ?? null;
  return [runId, runId];
}

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
  }

  /** {@inheritDoc StoreKeyRotation.reencryptBatch} */
  async reencryptBatch(input: ReencryptBatchInput) {
    const { targetKeyId, limit, afterCursor } = ReencryptBatchInputSchema.parse(input);
    if (!this.codec.encrypted) {
      return StoreReencryptBatchResultSchema.parse({ processed: 0 });
    }
    const cursor = afterCursor === undefined ? undefined : decodeStoreRotationCursor(afterCursor);
    const selected: StoreRotationUpdate[] = [];
    let nextCursor: StoreRotationCursor | undefined;

    try {
      if (cursor?.table !== "snapshots") {
        const events = this.db
          .prepare<
            [string, number | null, number | null, number],
            StoreRotationEventRow
          >(
            `SELECT global_seq, run_id, seq, content_blob, key_id
             FROM events
             WHERE key_id IS NOT NULL AND key_id != ? AND (? IS NULL OR global_seq > ?)
             ORDER BY global_seq LIMIT ?`,
          )
          .all(targetKeyId, cursor?.after ?? null, cursor?.after ?? 0, limit + 1);
        const eventBatch = events.slice(0, limit);
        for (const row of eventBatch) {
          const runId = Id.parse(row.run_id);
          const context = { runId, seq: row.seq };
          const content = await this.codec.decode(context, row.content_blob, row.key_id);
          const encoded = await this.codec.encode(context, content, targetKeyId);
          if (encoded.keyId !== targetKeyId) {
            throw new ContentEncryptFailedError();
          }
          selected.push({
            table: "events",
            globalSeq: row.global_seq,
            runId,
            seq: row.seq,
            blob: encoded.blob,
            oldBlob: row.content_blob,
            oldKeyId: row.key_id,
          });
        }
        if (events.length > limit) {
          const last = eventBatch.at(-1);
          if (last !== undefined) {
            nextCursor = { table: "events", after: last.global_seq };
          }
        } else {
          const remaining = limit - eventBatch.length;
          const snapshots = this.db
            .prepare<[string, number], StoreRotationSnapshotRow>(
              `SELECT snapshot_id, run_id, at_seq, content_blob, key_id
               FROM snapshots
               WHERE key_id IS NOT NULL AND key_id != ?
               ORDER BY snapshot_id LIMIT ?`,
            )
            .all(targetKeyId, Math.max(1, remaining + 1));
          const snapshotBatch = snapshots.slice(0, remaining);
          for (const row of snapshotBatch) {
            const runId = Id.parse(row.run_id);
            const context = { runId, seq: row.at_seq, purpose: "snapshot" as const };
            const content = await this.codec.decode(context, row.content_blob, row.key_id);
            const encoded = await this.codec.encode(context, content, targetKeyId);
            if (encoded.keyId !== targetKeyId) {
              throw new ContentEncryptFailedError();
            }
            selected.push({
              table: "snapshots",
              snapshotId: row.snapshot_id,
              runId,
              seq: row.at_seq,
              blob: encoded.blob,
              oldBlob: row.content_blob,
              oldKeyId: row.key_id,
            });
          }
          if (snapshots.length > remaining) {
            const last = snapshotBatch.at(-1);
            if (last !== undefined) {
              nextCursor = { table: "snapshots", after: last.snapshot_id };
            } else {
              nextCursor = { table: "snapshots" };
            }
          }
        }
      } else {
        const snapshots = this.db
          .prepare<
            [string, string, number],
            StoreRotationSnapshotRow
          >(
            `SELECT snapshot_id, run_id, at_seq, content_blob, key_id
             FROM snapshots
             WHERE key_id IS NOT NULL AND key_id != ? AND snapshot_id > ?
             ORDER BY snapshot_id LIMIT ?`,
          )
          .all(targetKeyId, cursor.after ?? "", limit + 1);
        const snapshotBatch = snapshots.slice(0, limit);
        for (const row of snapshotBatch) {
          const runId = Id.parse(row.run_id);
          const context = { runId, seq: row.at_seq, purpose: "snapshot" as const };
          const content = await this.codec.decode(context, row.content_blob, row.key_id);
          const encoded = await this.codec.encode(context, content, targetKeyId);
          if (encoded.keyId !== targetKeyId) {
            throw new ContentEncryptFailedError();
          }
          selected.push({
            table: "snapshots",
            snapshotId: row.snapshot_id,
            runId,
            seq: row.at_seq,
            blob: encoded.blob,
            oldBlob: row.content_blob,
            oldKeyId: row.key_id,
          });
        }
        if (snapshots.length > limit) {
          const last = snapshotBatch.at(-1);
          if (last !== undefined) {
            nextCursor = { table: "snapshots", after: last.snapshot_id };
          }
        }
      }

      const rotate = this.db.transaction(() =>
        selected.reduce((processed, row) => {
          const result =
            row.table === "events"
              ? this.db
                  .prepare(
                    "UPDATE events SET content_blob = ?, key_id = ? WHERE global_seq = ? AND key_id = ? AND content_blob = ?",
                  )
                  .run(row.blob, targetKeyId, row.globalSeq, row.oldKeyId, row.oldBlob)
              : this.db
                  .prepare(
                    "UPDATE snapshots SET content_blob = ?, key_id = ? WHERE snapshot_id = ? AND key_id = ? AND content_blob = ?",
                  )
                  .run(row.blob, targetKeyId, row.snapshotId, row.oldKeyId, row.oldBlob);
          return processed + result.changes;
        }, 0),
      );
      const processed = rotate.immediate();
      return StoreReencryptBatchResultSchema.parse({
        processed,
        ...(nextCursor === undefined
          ? {}
          : { nextCursor: encodeStoreRotationCursor(nextCursor) }),
      });
    } catch (error) {
      if (
        error instanceof ContentDecryptFailedError ||
        error instanceof ContentEncryptFailedError ||
        error instanceof KeyNotFoundError
      ) {
        throw error;
      }
      throw new StoreUnavailableError();
    }
  }

  /** Count event and snapshot rows that still use each key. */
  countRowsByKey(): Promise<readonly { keyId: string; count: number }[]> {
    try {
      const rows = this.db
        .prepare<[], { key_id: string; count: number }>(
          `SELECT key_id, COUNT(*) AS count FROM (
             SELECT key_id FROM events WHERE key_id IS NOT NULL
             UNION ALL
             SELECT key_id FROM snapshots WHERE key_id IS NOT NULL
           ) GROUP BY key_id ORDER BY key_id`,
        )
        .all();
      return Promise.resolve(
        rows.map(({ key_id, count }) => StoreKeyRowCountSchema.parse({ keyId: key_id, count })),
      );
    } catch {
      return Promise.reject(new StoreUnavailableError());
    }
  }

  /** {@inheritDoc EventStore.append} */
  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
  ): Promise<{ nextSeq: number }> {
    const encoded = await encodeEvents(this.codec, runId, events, expectedSeq);
    return this.writeAppend(runId, encoded, expectedSeq);
  }

  /** {@inheritDoc EventStore.appendWithSnapshot} */
  async appendWithSnapshot(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Snapshot,
  ): Promise<{ nextSeq: number }> {
    const validatedSnapshot = validateSnapshotAppend(runId, events, expectedSeq, snapshot);
    const [encoded, encodedSnapshot] = await Promise.all([
      encodeEvents(this.codec, runId, events, expectedSeq),
      encodeSnapshot(this.codec, validatedSnapshot),
    ]);
    return this.writeAppend(runId, encoded, expectedSeq, encodedSnapshot);
  }

  private writeAppend(
    runId: Id,
    encoded: readonly EncodedEvent[],
    expectedSeq: number,
    encodedSnapshot?: EncodedSnapshot,
  ): { nextSeq: number } {
    const validated = encoded.map(({ event }) => event);

    try {
      const appendTransaction = this.db.transaction(() => {
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

  /** {@inheritDoc EventStore.listRuns} */
  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      return Promise.reject(new InvalidEventError([["limit"]]));
    }

    try {
      const cursor = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor);
      const continuationParams = continuationRunParams(opts.continuationOf);
      const rows = this.listRunsQuery.all(
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
      return Promise.reject(storeError(error));
    }
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
