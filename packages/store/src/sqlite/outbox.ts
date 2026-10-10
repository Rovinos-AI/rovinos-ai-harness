// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { Code, Id, type Event as StoredEvent } from "@harness/schemas";
import type { ContentCodec } from "../codec.js";
import { InvalidEventError, StoreUnavailableError } from "../errors.js";
import type { Clock } from "../types.js";
import {
  decodeStoredContent,
  eventFromRow,
  parseStoredMeta,
  type EventRow,
} from "./serialization.js";

type OutboxEventRow = EventRow & { global_seq: number };

/** Normalize SQLite busy failures to the store error contract. */
export function sqliteStoreError(error: unknown): Error {
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

/** SQLite cursor persistence and global-sequence event reads for the outbox API. */
export class SqliteOutboxReader {
  private readonly getCursor: Database.Statement<[string], { cursor: number }>;
  private readonly readBatch: Database.Statement<[number, number], OutboxEventRow>;
  private readonly updateCursor: Database.Statement<[string, number, number]>;

  constructor(
    db: Database.Database,
    private readonly codec: ContentCodec,
    private readonly clock: Clock,
  ) {
    this.getCursor = db.prepare<[string], { cursor: number }>(
      "SELECT cursor FROM sink_cursors WHERE sink_id = ?",
    );
    this.readBatch = db.prepare<[number, number], OutboxEventRow>(
      "SELECT global_seq, run_id, seq, ts, type, trace_id, span_id, segment_id, meta_json, content_blob, key_id FROM events WHERE global_seq > ? ORDER BY global_seq LIMIT ?",
    );
    this.updateCursor = db.prepare<[string, number, number]>(
      "INSERT INTO sink_cursors (sink_id, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT (sink_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at WHERE excluded.cursor > sink_cursors.cursor",
    );
  }

  /** Fetch the next ordered, at-least-once batch for one sink. */
  async fetch(sinkId: Code, limit: number): Promise<{ events: StoredEvent[]; cursor: number }> {
    const parsedSinkId = Code.safeParse(sinkId);
    if (!parsedSinkId.success) {
      throw new InvalidEventError([["sinkId"]]);
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new InvalidEventError([["limit"]]);
    }
    try {
      const lastAcked = this.getCursor.get(parsedSinkId.data)?.cursor ?? 0;
      // SQLite serializes writers, so this ordered scan needs no transaction-visibility filter.
      const rows = this.readBatch.all(lastAcked, limit);
      const events: StoredEvent[] = [];
      for (const row of rows) {
        const runId = Id.safeParse(row.run_id);
        if (!runId.success) {
          throw new StoreUnavailableError();
        }
        const storedMeta = parseStoredMeta(row.meta_json);
        const content = await decodeStoredContent(this.codec, runId.data, row);
        events.push(eventFromRow(row, storedMeta, content));
      }
      return { events, cursor: rows.at(-1)?.global_seq ?? lastAcked };
    } catch (error) {
      throw sqliteStoreError(error);
    }
  }

  /** Advance a sink cursor only when the supplied cursor is greater. */
  ack(sinkId: Code, cursor: number): Promise<void> {
    const parsedSinkId = Code.safeParse(sinkId);
    if (!parsedSinkId.success) {
      return Promise.reject(new InvalidEventError([["sinkId"]]));
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return Promise.reject(new InvalidEventError([["cursor"]]));
    }
    try {
      this.updateCursor.run(parsedSinkId.data, cursor, this.clock.now());
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(sqliteStoreError(error));
    }
  }
}
