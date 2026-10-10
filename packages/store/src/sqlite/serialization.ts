// SPDX-License-Identifier: Apache-2.0
import { Id, RunStatus, joinEvent, parseJson, type Event as StoredEvent } from "@harness/schemas";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ContentCodec, EncodedSnapshot } from "../codec.js";
import {
  ContentDecryptFailedError,
  InvalidEventError,
  KeyNotFoundError,
  StoreEncryptionMismatchError,
  StoreUnavailableError,
} from "../errors.js";
import type { RunSummary } from "../types.js";

/** Initialize or validate the durable content-encryption mode for a SQLite database. */
export function initializeEncryptionMetadata(db: Database.Database, encrypted: boolean): void {
  const encryptionValue = encrypted ? "true" : "false";
  const readMetadata = db.prepare<[string], { metadata_value: string }>(
    "SELECT metadata_value FROM store_metadata WHERE metadata_key = ?",
  );
  const insertMetadata = db.prepare<[string, string]>(
    "INSERT INTO store_metadata (metadata_key, metadata_value) VALUES (?, ?)",
  );
  const contentCount = db.prepare<[], { count: number }>(
    "SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM snapshots) AS count",
  );

  db.transaction(() => {
    const stored = readMetadata.get("encrypted");
    if (stored === undefined) {
      if (encrypted && (contentCount.get()?.count ?? 0) > 0) {
        throw new StoreEncryptionMismatchError();
      }
      insertMetadata.run("encrypted", encryptionValue);
    } else if (stored.metadata_value !== encryptionValue) {
      throw new StoreEncryptionMismatchError();
    }
  }).immediate();
}

/** Validate encryption mode without writing metadata when opening a read-only store. */
export function validateEncryptionMetadata(db: Database.Database, encrypted: boolean): void {
  const readMetadata = db.prepare<[string], { metadata_value: string }>(
    "SELECT metadata_value FROM store_metadata WHERE metadata_key = ?",
  );
  const contentCount = db.prepare<[], { count: number }>(
    "SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM snapshots) AS count",
  );
  const stored = readMetadata.get("encrypted");
  if (stored === undefined) {
    if (encrypted && (contentCount.get()?.count ?? 0) > 0) {
      throw new StoreEncryptionMismatchError();
    }
  } else if (stored.metadata_value !== String(encrypted)) {
    throw new StoreEncryptionMismatchError();
  }
}

const envelopeKeys = new Set(["runId", "seq", "ts", "type", "traceId", "spanId", "segmentId"]);
const contentRecordSchema = z.record(z.string(), z.json());

/** Database representation of one persisted event row. */
export interface EventRow {
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

/** Database representation of one persisted run row. */
export interface RunRow {
  next_seq: number;
  status: string;
}

/** Database representation of a run-listing row. */
export interface RunSummaryRow {
  run_id: string;
  created_at: number;
  status: string;
  last_seq: number;
  last_ts: number;
}

/** Convert a SQLite run-list page into the event-store result and opaque cursor. */
export function runListPage(
  rows: readonly RunSummaryRow[],
  limit: number,
): { runs: RunSummary[]; nextCursor?: string } {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const runs = page.map((row) => ({
    runId: Id.parse(row.run_id),
    createdAt: row.created_at,
    status: RunStatus.parse(row.status),
    lastSeq: row.last_seq,
    lastTs: row.last_ts,
  }));
  const last = page.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? Buffer.from(JSON.stringify([last.created_at, last.run_id])).toString("base64url")
      : undefined;
  return nextCursor === undefined ? { runs } : { runs, nextCursor };
}

/** Insert a snapshot and normalize primary-key collisions to the store contract. */
export function insertSnapshot(
  statement: Database.Statement<[string, Id, number, number, string, string, string | null]>,
  snapshot: EncodedSnapshot,
): void {
  try {
    statement.run(
      snapshot.snapshot_id,
      snapshot.run_id,
      snapshot.at_seq,
      snapshot.created_at,
      snapshot.meta_json,
      snapshot.content_blob,
      snapshot.key_id,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "SQLITE_CONSTRAINT_PRIMARY" + "KEY"
    ) {
      throw new InvalidEventError([["snapshotId"]]);
    }
    throw error;
  }
}

/** Parse and validate event metadata read from SQLite. */
export function parseStoredMeta(metaJson: string): Record<string, unknown> {
  let storedMeta: Record<string, unknown>;
  try {
    storedMeta = parseJson(contentRecordSchema, metaJson);
  } catch {
    throw new StoreUnavailableError();
  }
  if (Object.keys(storedMeta).some((key) => envelopeKeys.has(key))) {
    throw new StoreUnavailableError();
  }
  return storedMeta;
}

/** Decode and validate event content read from SQLite. */
export async function decodeStoredContent(
  codec: ContentCodec,
  runId: Id,
  row: EventRow,
): Promise<Record<string, unknown>> {
  try {
    const decoded = await codec.decode(
      { runId, seq: row.seq },
      row.content_blob,
      row.key_id ?? undefined,
    );
    const result = contentRecordSchema.safeParse(decoded);
    if (!result.success) {
      throw new StoreUnavailableError();
    }
    return result.data;
  } catch (error) {
    if (error instanceof ContentDecryptFailedError || error instanceof KeyNotFoundError) {
      throw error;
    }
    throw new StoreUnavailableError();
  }
}

/** Reconstruct and validate one event read from SQLite. */
export function eventFromRow(
  row: EventRow,
  storedMeta: Record<string, unknown>,
  content: Record<string, unknown>,
): StoredEvent {
  const storedRunId = Id.safeParse(row.run_id);
  if (!storedRunId.success) {
    throw new StoreUnavailableError();
  }
  try {
    return joinEvent(
      {
        ...storedMeta,
        runId: storedRunId.data,
        seq: row.seq,
        ts: row.ts,
        type: row.type,
        traceId: row.trace_id,
        spanId: row.span_id,
        segmentId: row.segment_id,
      },
      content,
    );
  } catch {
    throw new StoreUnavailableError();
  }
}
