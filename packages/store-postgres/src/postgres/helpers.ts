// SPDX-License-Identifier: Apache-2.0
import {
  ContractError,
  Id,
  RunStatus,
  joinEvent,
  parseJson,
  splitEvent,
  upcastEvent,
  type Event as StoredEvent,
  type NewEvent,
} from "@rovinos/schemas";
import type { QueryResultRow } from "pg";
import { z } from "zod";
import type { ContentCodec, RunSummary } from "@rovinos/store/adapter-internal";
import {
  ContentDecryptFailedError,
  InvalidEventError,
  KeyNotFoundError,
  SeqConflictError,
  StoreUnavailableError,
  isPreservedStoreError,
} from "@rovinos/store/adapter-internal";

const envelopeKeys = new Set(["runId", "seq", "ts", "type", "traceId", "spanId", "segmentId"]);
const contentRecordSchema = z.record(z.string(), z.json());
const runCursorSchema = z.tuple([z.number().int().nonnegative(), Id]);
export const READ_PAGE_SIZE = 1_024;

/** Database representation of one persisted event row. */
export interface EventRow extends QueryResultRow {
  run_id: string;
  seq: number | string;
  ts: number | string;
  type: string;
  trace_id: string;
  span_id: string;
  segment_id: string;
  meta: unknown;
  content_blob: string;
  key_id: string | null;
}

/** Database representation of a run-listing row. */
export interface RunSummaryRow extends QueryResultRow {
  run_id: string;
  created_at: number | string;
  status: string;
  last_seq: number | string;
  last_ts: number | string;
}

/** Event metadata and content prepared for one transactional append. */
export interface EncodedEvent {
  event: StoredEvent;
  meta: string;
  blob: string;
  keyId: string | null;
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

/** Convert driver conflicts and connectivity failures to the store error contract. */
export function storeError(
  error: unknown,
  expected = 0,
  actual = expected,
  uniqueViolationIsConflict = false,
): Error {
  if (isPreservedStoreError(error)) {
    return error;
  }
  const code = errorCode(error);
  if (code === "23505" && uniqueViolationIsConflict && actual !== expected) {
    return new SeqConflictError(expected, actual);
  }
  if (
    code?.startsWith("08") === true ||
    code?.startsWith("57P0") === true ||
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(code ?? "")
  ) {
    return new StoreUnavailableError();
  }
  return new StoreUnavailableError();
}

/** Convert a Postgres integer representation while rejecting unsafe values. */
export function integer(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new StoreUnavailableError();
  }
  return result;
}

/** Validate events and encode their content before a database transaction starts. */
export async function encodeEvents(
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
    try {
      validated.push(upcastEvent({ ...event, seq: expectedSeq + index }));
    } catch (error) {
      if (error instanceof ContractError) {
        throw new InvalidEventError(error.issues.map(({ path }) => [...path]));
      }
      throw new InvalidEventError([[]]);
    }
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
        meta: JSON.stringify(meta),
        blob: content.blob,
        keyId: content.keyId ?? null,
      };
    }),
  );
}

function parseStoredMeta(meta: unknown): Record<string, unknown> {
  const parsed = contentRecordSchema.safeParse(meta);
  if (!parsed.success || Object.keys(parsed.data).some((key) => envelopeKeys.has(key))) {
    throw new StoreUnavailableError();
  }
  return parsed.data;
}

async function decodeStoredContent(
  codec: ContentCodec,
  runId: Id,
  row: EventRow,
): Promise<Record<string, unknown>> {
  try {
    const decoded = await codec.decode(
      { runId, seq: integer(row.seq) },
      row.content_blob,
      row.key_id ?? undefined,
    );
    const parsed = contentRecordSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new StoreUnavailableError();
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof ContentDecryptFailedError || error instanceof KeyNotFoundError) {
      throw error;
    }
    throw new StoreUnavailableError();
  }
}

/** Reconstruct and validate an event read from Postgres. */
export async function eventFromRow(
  codec: ContentCodec,
  runId: Id,
  row: EventRow,
): Promise<StoredEvent> {
  const storedRunId = Id.safeParse(row.run_id);
  if (!storedRunId.success) {
    throw new StoreUnavailableError();
  }
  const meta = parseStoredMeta(row.meta);
  const content = await decodeStoredContent(codec, runId, row);
  try {
    return joinEvent(
      {
        ...meta,
        runId: storedRunId.data,
        seq: integer(row.seq),
        ts: integer(row.ts),
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

/** Decode and validate the opaque run-listing cursor. */
export function decodeCursor(cursor: string): { createdAt: number; runId: Id } {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [createdAt, runId] = parseJson(runCursorSchema, decoded);
    return { createdAt, runId };
  } catch {
    throw new InvalidEventError([["cursor"]]);
  }
}

function encodeCursor(createdAt: number, runId: string): string {
  return Buffer.from(JSON.stringify([createdAt, runId])).toString("base64url");
}

/** Convert ordered database rows into a run-listing page. */
export function runListPage(
  rows: readonly RunSummaryRow[],
  limit: number,
): { runs: RunSummary[]; nextCursor?: string } {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const runs = page.map((row) => ({
    runId: Id.parse(row.run_id),
    createdAt: integer(row.created_at),
    status: RunStatus.parse(row.status),
    lastSeq: integer(row.last_seq),
    lastTs: integer(row.last_ts),
  }));
  const last = page.at(-1);
  const nextCursor =
    hasMore && last !== undefined ? encodeCursor(integer(last.created_at), last.run_id) : undefined;
  return nextCursor === undefined ? { runs } : { runs, nextCursor };
}
