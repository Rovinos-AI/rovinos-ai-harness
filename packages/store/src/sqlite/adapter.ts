// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import {
  Event,
  Id,
  RunStatus,
  joinEvent,
  parseJson,
  splitEvent,
  type Event as StoredEvent,
  type NewEvent,
} from "@harness/schemas";
import { z } from "zod";
import { JsonContentCodec, type ContentCodec } from "../codec.js";
import { InvalidEventError, SeqConflictError, StoreUnavailableError } from "../errors.js";
import type { EventStore, ListRunsOptions, RunSummary } from "../types.js";
import { SQLITE_SCHEMA } from "./schema.sql.js";

const envelopeKeys = new Set(["runId", "seq", "ts", "type", "traceId", "spanId", "segmentId"]);
const contentRecordSchema = z.record(z.string(), z.json());
const runCursorSchema = z.tuple([z.number().int().nonnegative(), Id]);

interface EventRow {
  run_id: string;
  seq: number;
  ts: number;
  type: string;
  trace_id: string;
  span_id: string;
  segment_id: string;
  meta_json: string;
  content_blob: string;
  key_id: string | null;
}

interface RunRow {
  next_seq: number;
  status: string;
}

interface RunSummaryRow {
  run_id: string;
  created_at: number;
  status: string;
  last_seq: number;
  last_ts: number;
}

interface EncodedEvent {
  event: StoredEvent;
  metaJson: string;
  blob: string;
  keyId: string | null;
}

function storeError(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_BUSY")
  ) {
    return new StoreUnavailableError();
  }
  return error instanceof Error ? error : new StoreUnavailableError();
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

function encodeCursor(createdAt: number, runId: Id): string {
  return Buffer.from(JSON.stringify([createdAt, runId])).toString("base64url");
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
  private readonly readEvents: Database.Statement<[Id, number, number | null, number | null], EventRow>;
  private readonly getHead: Database.Statement<[Id], { next_seq: number }>;
  private readonly listRunsQuery: Database.Statement<
    [RunStatus | null, RunStatus | null, number | null, number | null, number | null, Id | null, number],
    RunSummaryRow
  >;

  /**
   * Open a SQLite database and initialize its initial schema.
   *
   * @param path Database file path or `:memory:`.
   * @param codec Codec used to store content separately from event metadata.
   */
  constructor(path: string, codec: ContentCodec = new JsonContentCodec()) {
    this.db = new Database(path);
    this.codec = codec;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SQLITE_SCHEMA);

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
    this.readEvents = this.db.prepare<
      [Id, number, number | null, number | null],
      EventRow
    >(
      "SELECT seq, ts, type, trace_id, span_id, segment_id, meta_json, content_blob, key_id FROM events WHERE run_id = ? AND seq >= ? AND (? IS NULL OR seq <= ?) ORDER BY seq",
    );
    this.getHead = this.db.prepare<[Id], { next_seq: number }>(
      "SELECT next_seq FROM runs WHERE run_id = ?",
    );
    this.listRunsQuery = this.db.prepare<
      [RunStatus | null, RunStatus | null, number | null, number | null, number | null, Id | null, number],
      RunSummaryRow
    >(`
      SELECT runs.run_id, created.ts AS created_at, runs.status, runs.next_seq - 1 AS last_seq, runs.last_ts
      FROM runs
      JOIN events AS created ON created.run_id = runs.run_id AND created.type = 'run_created'
      WHERE created.global_seq = (
        SELECT MIN(first_created.global_seq)
        FROM events AS first_created
        WHERE first_created.run_id = runs.run_id AND first_created.type = 'run_created'
      )
      AND (? IS NULL OR runs.status = ?)
      AND (? IS NULL OR created.ts < ? OR (created.ts = ? AND runs.run_id > ?))
      ORDER BY created.ts DESC, runs.run_id ASC
      LIMIT ?
    `);
  }

  /** {@inheritDoc EventStore.append} */
  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
  ): Promise<{ nextSeq: number }> {
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

    const encoded: EncodedEvent[] = await Promise.all(
      validated.map(async (event) => {
        const parts = splitEvent(event);
        const content = await this.codec.encode({ runId, seq: event.seq }, parts.content);
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
      });
      appendTransaction.immediate();
      return { nextSeq: expectedSeq + validated.length };
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.read} */
  async *read(
    runId: Id,
    range?: { fromSeq?: number; toSeq?: number },
  ): AsyncIterable<StoredEvent> {
    const fromSeq = range?.fromSeq ?? 0;
    const toSeq = range?.toSeq ?? null;
    try {
      for (const row of this.readEvents.iterate(runId, fromSeq, toSeq, toSeq)) {
        const storedMeta = parseJson(contentRecordSchema, row.meta_json);
        const meta = {
          runId,
          seq: row.seq,
          ts: row.ts,
          type: row.type,
          traceId: row.trace_id,
          spanId: row.span_id,
          segmentId: row.segment_id,
          ...storedMeta,
        };
        const content = await this.codec.decode(
          { runId, seq: row.seq },
          row.content_blob,
          row.key_id ?? undefined,
        );
        yield joinEvent(meta, contentRecordSchema.parse(content));
      }
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.head} */
  async head(runId: Id): Promise<number> {
    try {
      const row = this.getHead.get(runId);
      return row?.next_seq ?? 0;
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.listRuns} */
  async listRuns(
    opts: ListRunsOptions,
  ): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new InvalidEventError([["limit"]]);
    }

    const cursor = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor);
    try {
      const rows = this.listRunsQuery.all(
        opts.status ?? null,
        opts.status ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.runId ?? null,
        opts.limit + 1,
      );
      const hasMore = rows.length > opts.limit;
      const page = rows.slice(0, opts.limit);
      const runs = page.map((row) => ({
        runId: Id.parse(row.run_id),
        createdAt: row.created_at,
        status: RunStatus.parse(row.status),
        lastSeq: row.last_seq,
        lastTs: row.last_ts,
      }));
      const last = page.at(-1);
      const nextCursor =
        hasMore && last !== undefined ? encodeCursor(last.created_at, last.run_id) : undefined;
      return nextCursor === undefined ? { runs } : { runs, nextCursor };
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.close} */
  async close(): Promise<void> {
    try {
      this.db.close();
    } catch (error) {
      throw storeError(error);
    }
  }
}
