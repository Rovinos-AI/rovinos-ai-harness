// SPDX-License-Identifier: Apache-2.0
import type { Id, RunStatus } from "@harness/schemas";
import type { PoolClient } from "pg";
import type { EncodedEvent } from "./helpers.js";

const MAX_EVENTS_PER_INSERT = 5_000;

function batchPlaceholders(offset: number): string {
  return `(${Array.from({ length: 10 }, (_, index) => {
    const position = `$${(offset + index + 1).toString()}`;
    return index === 7 ? `${position}::jsonb` : position;
  }).join(", ")})`;
}

/** Inserts encoded events in bounded batches and atomically advances their run row. */
export async function insertPostgresEventBatches(
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
