// SPDX-License-Identifier: Apache-2.0
import { Id } from "@harness/schemas";
import type { Pool, QueryResultRow } from "pg";
import {
  ContentDecryptFailedError,
  ContentEncryptFailedError,
  KeyNotFoundError,
  StoreUnavailableError,
} from "../errors.js";
import type { ContentCodec } from "../codec.js";
import {
  decodeStoreRotationCursor,
  encodeStoreRotationCursor,
  ReencryptBatchInputSchema,
  StoreKeyRowCountSchema,
  StoreReencryptBatchResultSchema,
  type ReencryptBatchInput,
  type StoreKeyRowCount,
  type StoreReencryptBatchResult,
  type StoreRotationCursor,
} from "../rotate.js";
import { integer } from "./helpers.js";

interface RotationEventRow extends QueryResultRow {
  global_seq: number | string;
  run_id: string;
  seq: number | string;
  content_blob: string;
  key_id: string;
}

interface RotationSnapshotRow extends QueryResultRow {
  snapshot_id: string;
  run_id: string;
  at_seq: number | string;
  content_blob: string;
  key_id: string;
}

type RotationUpdate =
  | {
      readonly table: "events";
      readonly globalSeq: number;
      readonly blob: string;
      readonly oldBlob: string;
      readonly oldKeyId: string;
    }
  | {
      readonly table: "snapshots";
      readonly snapshotId: string;
      readonly blob: string;
      readonly oldBlob: string;
      readonly oldKeyId: string;
    };

interface SelectedBatch {
  readonly updates: readonly RotationUpdate[];
  readonly nextCursor?: StoreRotationCursor;
}

interface SelectBatchInput {
  readonly pool: Pool;
  readonly codec: ContentCodec;
  readonly targetKeyId: string;
  readonly limit: number;
  readonly cursor: StoreRotationCursor | undefined;
}

async function selectEvents(
  pool: Pool,
  targetKeyId: string,
  after: number | undefined,
  limit: number,
): Promise<RotationEventRow[]> {
  const result = await pool.query<RotationEventRow>(
    `SELECT global_seq, run_id, seq, content_blob, key_id
      FROM events
      WHERE key_id IS NOT NULL AND key_id <> $1
        AND ($2::bigint IS NULL OR global_seq > $2::bigint)
      ORDER BY global_seq LIMIT $3`,
    [targetKeyId, after ?? null, limit],
  );
  return result.rows;
}

async function selectSnapshots(
  pool: Pool,
  targetKeyId: string,
  after: string | undefined,
  limit: number,
): Promise<RotationSnapshotRow[]> {
  const result = await pool.query<RotationSnapshotRow>(
    `SELECT snapshot_id, run_id, at_seq, content_blob, key_id
      FROM snapshots
      WHERE key_id IS NOT NULL AND key_id <> $1
        AND ($2::text IS NULL OR snapshot_id > $2)
      ORDER BY snapshot_id LIMIT $3`,
    [targetKeyId, after ?? null, limit],
  );
  return result.rows;
}

async function encryptEvent(
  codec: ContentCodec,
  row: RotationEventRow,
  targetKeyId: string,
): Promise<RotationUpdate> {
  const runId = Id.parse(row.run_id);
  const context = { runId, seq: integer(row.seq) };
  const content = await codec.decode(context, row.content_blob, row.key_id);
  const encoded = await codec.encode(context, content, targetKeyId);
  if (encoded.keyId !== targetKeyId) {
    throw new ContentEncryptFailedError();
  }
  return {
    table: "events",
    globalSeq: integer(row.global_seq),
    blob: encoded.blob,
    oldBlob: row.content_blob,
    oldKeyId: row.key_id,
  };
}

async function encryptSnapshot(
  codec: ContentCodec,
  row: RotationSnapshotRow,
  targetKeyId: string,
): Promise<RotationUpdate> {
  const runId = Id.parse(row.run_id);
  const context = { runId, seq: integer(row.at_seq), purpose: "snapshot" as const };
  const content = await codec.decode(context, row.content_blob, row.key_id);
  const encoded = await codec.encode(context, content, targetKeyId);
  if (encoded.keyId !== targetKeyId) {
    throw new ContentEncryptFailedError();
  }
  return {
    table: "snapshots",
    snapshotId: row.snapshot_id,
    blob: encoded.blob,
    oldBlob: row.content_blob,
    oldKeyId: row.key_id,
  };
}

async function encryptEvents(
  codec: ContentCodec,
  rows: readonly RotationEventRow[],
  targetKeyId: string,
): Promise<RotationUpdate[]> {
  const updates: RotationUpdate[] = [];
  for (const row of rows) {
    updates.push(await encryptEvent(codec, row, targetKeyId));
  }
  return updates;
}

async function encryptSnapshots(
  codec: ContentCodec,
  rows: readonly RotationSnapshotRow[],
  targetKeyId: string,
): Promise<RotationUpdate[]> {
  const updates: RotationUpdate[] = [];
  for (const row of rows) {
    updates.push(await encryptSnapshot(codec, row, targetKeyId));
  }
  return updates;
}

async function selectBatch({
  pool,
  codec,
  targetKeyId,
  limit,
  cursor,
}: SelectBatchInput): Promise<SelectedBatch> {
  if (cursor?.table === "snapshots") {
    const rows = await selectSnapshots(pool, targetKeyId, cursor.after, limit + 1);
    const batch = rows.slice(0, limit);
    const last = batch.at(-1);
    return {
      updates: await encryptSnapshots(codec, batch, targetKeyId),
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: { table: "snapshots" as const, after: last.snapshot_id } }
        : {}),
    };
  }

  const eventRows = await selectEvents(pool, targetKeyId, cursor?.after, limit + 1);
  const eventBatch = eventRows.slice(0, limit);
  const eventUpdates = await encryptEvents(codec, eventBatch, targetKeyId);
  const lastEvent = eventBatch.at(-1);
  if (eventRows.length > limit && lastEvent !== undefined) {
    return {
      updates: eventUpdates,
      nextCursor: { table: "events", after: integer(lastEvent.global_seq) },
    };
  }

  const remaining = limit - eventBatch.length;
  const snapshotRows = await selectSnapshots(
    pool,
    targetKeyId,
    undefined,
    Math.max(1, remaining + 1),
  );
  const snapshotBatch = snapshotRows.slice(0, remaining);
  const snapshotUpdates = await encryptSnapshots(codec, snapshotBatch, targetKeyId);
  const lastSnapshot = snapshotBatch.at(-1);
  let nextCursor: StoreRotationCursor | undefined;
  if (snapshotRows.length > remaining) {
    nextCursor =
      lastSnapshot === undefined
        ? { table: "snapshots" }
        : { table: "snapshots", after: lastSnapshot.snapshot_id };
  }
  return {
    updates: [...eventUpdates, ...snapshotUpdates],
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

async function updateBatch(
  pool: Pool,
  updates: readonly RotationUpdate[],
  targetKeyId: string,
): Promise<number> {
  const client = await pool.connect();
  let processed = 0;
  try {
    await client.query("BEGIN");
    for (const row of updates) {
      const result =
        row.table === "events"
          ? await client.query(
              "UPDATE events SET content_blob = $1, key_id = $2 WHERE global_seq = $3 AND key_id = $4 AND content_blob = $5",
              [row.blob, targetKeyId, row.globalSeq, row.oldKeyId, row.oldBlob],
            )
          : await client.query(
              "UPDATE snapshots SET content_blob = $1, key_id = $2 WHERE snapshot_id = $3 AND key_id = $4 AND content_blob = $5",
              [row.blob, targetKeyId, row.snapshotId, row.oldKeyId, row.oldBlob],
            );
      processed += result.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return processed;
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new StoreUnavailableError();
  } finally {
    client.release();
  }
}

/** Re-encrypt one bounded Postgres event/snapshot batch in a transaction. */
export async function reencryptPostgresBatch(
  pool: Pool,
  codec: ContentCodec,
  ensureInitialized: () => Promise<void>,
  input: ReencryptBatchInput,
): Promise<StoreReencryptBatchResult> {
  const { targetKeyId, limit, afterCursor } = ReencryptBatchInputSchema.parse(input);
  if (!codec.encrypted) {
    return StoreReencryptBatchResultSchema.parse({ processed: 0 });
  }
  await ensureInitialized();
  try {
    const cursor = afterCursor === undefined ? undefined : decodeStoreRotationCursor(afterCursor);
    const selected = await selectBatch({ pool, codec, targetKeyId, limit, cursor });
    const processed = await updateBatch(pool, selected.updates, targetKeyId);
    return StoreReencryptBatchResultSchema.parse({
      processed,
      ...(selected.nextCursor === undefined
        ? {}
        : { nextCursor: encodeStoreRotationCursor(selected.nextCursor) }),
    });
  } catch (error) {
    if (
      error instanceof ContentDecryptFailedError ||
      error instanceof ContentEncryptFailedError ||
      error instanceof KeyNotFoundError ||
      error instanceof StoreUnavailableError
    ) {
      throw error;
    }
    throw new StoreUnavailableError();
  }
}

/** Count encrypted event and snapshot rows grouped by key identifier. */
export async function countPostgresRowsByKey(
  pool: Pool,
  ensureInitialized: () => Promise<void>,
): Promise<readonly StoreKeyRowCount[]> {
  await ensureInitialized();
  try {
    const result = await pool.query<{ key_id: string; count: number | string }>(
      `SELECT key_id, COUNT(*)::int AS count FROM (
          SELECT key_id FROM events WHERE key_id IS NOT NULL
          UNION ALL
          SELECT key_id FROM snapshots WHERE key_id IS NOT NULL
        ) AS encrypted_rows GROUP BY key_id ORDER BY key_id`,
    );
    return result.rows.map(({ key_id, count }) =>
      StoreKeyRowCountSchema.parse({ keyId: key_id, count: integer(count) }),
    );
  } catch {
    throw new StoreUnavailableError();
  }
}
