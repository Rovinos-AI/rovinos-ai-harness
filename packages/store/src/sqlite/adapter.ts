// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import {
  Event,
  Id,
  RunStatus,
  parseJson,
  splitEvent,
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
import { InvalidEventError, SeqConflictError, StoreMigrationError } from "../errors.js";
import {
  systemClock,
  sqliteStoreOptionsSchema,
  type Clock,
  type EventStore,
  type ListRunsOptions,
  type RunSummary,
} from "../types.js";
import { SqliteOutboxReader, sqliteStoreError as storeError } from "./outbox.js";
import { migrate } from "../migrate.js";
import {
  decodeStoredContent,
  eventFromRow,
  initializeEncryptionMetadata,
  validateEncryptionMetadata,
  insertSnapshot,
  parseStoredMeta,
  runListPage,
  type EventRow,
  type RunRow,
  type RunSummaryRow,
} from "./serialization.js";
import { openReadOnlyDatabase } from "./read-only.js";
import { deleteRunTransaction } from "./retention.js";
import { SqliteApprovalNotifications } from "./approval-notifications.js";
import { findRunsByTrace } from "./traces.js";

const envelopeKeys = new Set(["runId", "seq", "ts", "type", "traceId", "spanId", "segmentId"]);
const runCursorSchema = z.tuple([z.number().int().nonnegative(), Id]);
const READ_PAGE_SIZE = 256;

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

interface EncodedEvent {
  event: StoredEvent;
  metaJson: string;
  blob: string;
  keyId: string | null;
}

async function encodeEvents(
  codec: ContentCodec,
  runId: Id,
  events: readonly NewEvent[],
  expectedSeq: number,
): Promise<EncodedEvent[]> {
  if (events.length === 0) {
    throw new InvalidEventError([[]]);
  }

  const validated: StoredEvent[] = [];
  for (const [index, event] of events.entries()) {
    if (event.runId !== runId) {
      throw new InvalidEventError([["runId"]]);
    }

    const result = Event.safeParse({ ...event, seq: expectedSeq + index });
    if (!result.success) {
      const paths = result.error.issues.map(({ path }) =>
        path.flatMap((part) =>
          typeof part === "string" || typeof part === "number" ? [part] : [],
        ),
      );
      throw new InvalidEventError(paths);
    }
    validated.push(result.data);
  }

  return Promise.all(
    validated.map(async (event) => {
      const parts = splitEvent(event);
      const content = await codec.encode({ runId, seq: event.seq }, parts.content);
      const meta = Object.fromEntries(
        Object.entries(parts.meta).filter(([key]) => !envelopeKeys.has(key)),
      );
      return {
        event,
        metaJson: JSON.stringify(meta),
        blob: content.blob,
        keyId: content.keyId ?? null,
      };
    }),
  );
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
export class SqliteEventStore implements EventStore {
  private readonly db: Database.Database;
  private readonly codec: ContentCodec;
  private readonly insertRun: Database.Statement<[Id, number, number]>;
  private readonly getRun: Database.Statement<[Id], RunRow>;
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
  private readonly outbox: SqliteOutboxReader;
  private readonly approvalNotifications: SqliteApprovalNotifications;

  /**
   * Open a SQLite database and initialize its initial schema.
   *
   * @param path Database file path or `:memory:`.
   * @param codec Codec used to store content separately from event metadata.
   * @param options Snapshot retention and read-only configuration; read-only opens an existing database without initialization.
   * @param clock Clock supplying timestamps for sink-cursor updates.
   */
  constructor(
    path: string,
    codec: ContentCodec = new JsonContentCodec(),
    options: z.input<typeof sqliteStoreOptionsSchema> = {},
    clock: Clock = systemClock,
  ) {
    const parsedOptions = sqliteStoreOptionsSchema.parse(options);
    this.db = parsedOptions.readOnly ? openReadOnlyDatabase(path) : new Database(path);
    this.codec = codec;
    this.snapshotKeep = snapshotKeep({ snapshotKeep: parsedOptions.snapshotKeep });
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

  /** {@inheritDoc EventStore.claimApprovalNotification} */
  claimApprovalNotification(approvalId: Id, runId: Id): Promise<boolean> {
    return this.approvalNotifications.claim(approvalId, runId);
  }

  /** {@inheritDoc EventStore.releaseApprovalNotification} */
  releaseApprovalNotification(approvalId: Id, runId: Id): Promise<void> {
    return this.approvalNotifications.release(approvalId, runId);
  }

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
