// SPDX-License-Identifier: Apache-2.0
import type { Event, Id } from "@rovinos/schemas";
import type { Pool } from "pg";
import type { ContentCodec } from "@rovinos/store/adapter-internal";
import { integer, storeError, eventFromRow, READ_PAGE_SIZE, type EventRow } from "./helpers.js";

/** Dependencies required for reading and decoding Postgres event rows. */
export interface PostgresEventReader {
  pool: Pool;
  codec: ContentCodec;
  ensureInitialized: () => Promise<void>;
}

/** Read decoded Postgres events in sequence order, using bounded database pages. */
export async function* readEvents(
  reader: PostgresEventReader,
  runId: Id,
  range?: { fromSeq?: number; toSeq?: number },
): AsyncIterable<Event> {
  const toSeq = range?.toSeq ?? null;
  let nextSeq = range?.fromSeq ?? 0;
  try {
    await reader.ensureInitialized();
    let rows = (
      await reader.pool.query<EventRow>(
        "SELECT run_id, seq, ts, type, trace_id, span_id, segment_id, meta, content_blob, key_id FROM events WHERE run_id = $1 AND seq >= $2 AND ($3::bigint IS NULL OR seq <= $3) ORDER BY seq LIMIT $4",
        [runId, nextSeq, toSeq, READ_PAGE_SIZE],
      )
    ).rows;
    while (rows.length !== 0) {
      for (const row of rows) {
        yield await eventFromRow(reader.codec, runId, row);
        nextSeq = integer(row.seq) + 1;
      }
      rows = (
        await reader.pool.query<EventRow>(
          "SELECT run_id, seq, ts, type, trace_id, span_id, segment_id, meta, content_blob, key_id FROM events WHERE run_id = $1 AND seq >= $2 AND ($3::bigint IS NULL OR seq <= $3) ORDER BY seq LIMIT $4",
          [runId, nextSeq, toSeq, READ_PAGE_SIZE],
        )
      ).rows;
    }
  } catch (error) {
    throw storeError(error);
  }
}
