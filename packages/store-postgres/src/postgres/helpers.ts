// SPDX-License-Identifier: Apache-2.0
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
import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import type { ContentCodec, EncodedSnapshot, RunSummary } from "@harness/store/adapter-internal";
import {
  ContentDecryptFailedError,
  InvalidEventError,
  KeyNotFoundError,
  RunExecutionLeaseLostError,
  SeqConflictError,
  StoreUnavailableError,
  isPreservedStoreError,
} from "@harness/store/adapter-internal";
import { insertSnapshot } from "./snapshot.js";

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

interface RunRow extends QueryResultRow {
  next_seq: number | string;
  status: string;
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

function batchPlaceholders(offset: number): string {
  return `(${Array.from({ length: 10 }, (_, index) => {
    const position = `$${(offset + index + 1).toString()}`;
    return index === 7 ? `${position}::jsonb` : position;
  }).join(", ")})`;
}

const MAX_EVENTS_PER_INSERT = 5_000;

function nextStatus(currentStatus: string, encoded: readonly EncodedEvent[]): RunStatus {
  const parsed = RunStatus.safeParse(currentStatus);
  if (!parsed.success) {
    throw new StoreUnavailableError();
  }
  let status = parsed.data;
  for (const { event } of encoded) {
    if (event.type === "run_status_changed") {
      status = event.to;
    }
  }
  return status;
}

async function insertEventBatches(
  client: PoolClient,
  encoded: readonly EncodedEvent[],
  options: { runId: Id; expectedSeq: number; status: RunStatus; lastTs: number },
): Promise<void> {
  const { runId, expectedSeq, status, lastTs } = options;
  for (let offset = 0; offset < encoded.length; offset += MAX_EVENTS_PER_INSERT) {
    const batch = encoded.slice(offset, offset + MAX_EVENTS_PER_INSERT);
    const values: (number | string | null)[] = [];
    const valueRows = batch.map(({ event, meta, blob, keyId }, index) => {
      values.push(
        runId,
        event.seq,
        event.ts,
        event.type,
        event.traceId,
        event.spanId,
        event.segmentId,
        meta,
        blob,
        keyId,
      );
      return batchPlaceholders(index * 10);
    });
    const insert = `INSERT INTO events (run_id, seq, ts, type, trace_id, span_id, segment_id, meta, content_blob, key_id)
      VALUES ${valueRows.join(", ")}`;
    if (offset + batch.length === encoded.length) {
      const updateOffset = values.length;
      values.push(expectedSeq + encoded.length, status, lastTs);
      await client.query(
        `WITH inserted_events AS (${insert}
          RETURNING run_id
        )
        UPDATE runs SET next_seq = $${(updateOffset + 1).toString()}, status = $${(updateOffset + 2).toString()}, last_ts = $${(updateOffset + 3).toString()}
        WHERE run_id IN (SELECT run_id FROM inserted_events)`,
        values,
      );
    } else {
      await client.query(insert, values);
    }
  }
}

/** Arguments for one atomic Postgres event and optional snapshot append. */
export interface AppendTransactionOptions {
  runId: Id;
  encoded: readonly EncodedEvent[];
  expectedSeq: number;
  encodedSnapshot?: EncodedSnapshot;
  snapshotKeep?: number;
  leaseOwner?: Id;
}

/** Append a batch atomically while holding the run's sequence row lock. */
export async function appendTransaction(
  client: PoolClient,
  options: AppendTransactionOptions,
): Promise<number> {
  const { runId, encoded, expectedSeq, encodedSnapshot, snapshotKeep = 5, leaseOwner } = options;
  const { first, last } = appendBoundaryEvents(encoded);

  let transactionStarted = false;
  let actualSeq = 0;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    transactionStarted = true;
    await client.query(
      "INSERT INTO runs (run_id, created_at, status, next_seq, last_ts) VALUES ($1, $2, 'pending', 0, $2) ON CONFLICT (run_id) DO NOTHING",
      [runId, first.ts],
    );
    const runResult = await client.query<RunRow>(
      "SELECT next_seq, status FROM runs WHERE run_id = $1 FOR UPDATE",
      [runId],
    );
    const run = runResult.rows[0];
    if (run === undefined) {
      throw new StoreUnavailableError();
    }
    actualSeq = integer(run.next_seq);
    if (actualSeq !== expectedSeq) {
      throw new SeqConflictError(expectedSeq, actualSeq);
    }
    await assertExecutionLease(client, runId, leaseOwner);
    if (actualSeq === 0 && first.type !== "run_created") {
      throw new InvalidEventError([[0, "type"]]);
    }

    const status = nextStatus(run.status, encoded);
    await insertEventBatches(client, encoded, {
      runId,
      expectedSeq,
      status,
      lastTs: last.ts,
    });
    if (encodedSnapshot !== undefined) {
      await insertSnapshot(client, encodedSnapshot);
      await client.query(
        "DELETE FROM snapshots WHERE run_id = $1 AND snapshot_id NOT IN (SELECT snapshot_id FROM snapshots WHERE run_id = $1 ORDER BY at_seq DESC, snapshot_id DESC LIMIT $2)",
        [runId, snapshotKeep],
      );
    }

    const finalSeq = last.seq.toString();
    await client.query("SELECT pg_notify($1, $2)", ["harness_events", `${runId}:${finalSeq}`]);
    await client.query("COMMIT");
    transactionStarted = false;
    return expectedSeq + encoded.length;
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw storeError(error, expectedSeq, actualSeq, true);
  }
}

function appendBoundaryEvents(encoded: readonly EncodedEvent[]): {
  readonly first: EncodedEvent["event"];
  readonly last: EncodedEvent["event"];
} {
  const first = encoded[0]?.event;
  const last = encoded.at(-1)?.event;
  if (first === undefined || last === undefined) {
    throw new InvalidEventError([[]]);
  }
  return { first, last };
}

async function assertExecutionLease(
  client: PoolClient,
  runId: Id,
  leaseOwner: Id | undefined,
): Promise<void> {
  if (leaseOwner === undefined) {
    return;
  }
  const leaseResult = await client.query<{ owner_id: string }>(
    "SELECT owner_id FROM run_execution_leases WHERE run_id = $1 FOR UPDATE",
    [runId],
  );
  if (leaseResult.rows[0]?.owner_id !== leaseOwner) {
    throw new RunExecutionLeaseLostError();
  }
}
