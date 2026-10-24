// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { Id } from "@rovinos/schemas";
import {
  ContentDecryptFailedError,
  ContentEncryptFailedError,
  KeyNotFoundError,
  StoreUnavailableError,
} from "@rovinos/store/adapter-internal";
import {
  decodeStoreRotationCursor,
  encodeStoreRotationCursor,
  ReencryptBatchInputSchema,
  StoreKeyRowCountSchema,
  StoreReencryptBatchResultSchema,
  type ContentCodec,
  type ReencryptBatchInput,
  type StoreKeyRowCount,
  type StoreReencryptBatchResult,
  type StoreRotationCursor,
} from "@rovinos/store/adapter-internal";

interface RotationEventRow {
  global_seq: number;
  run_id: string;
  seq: number;
  content_blob: string;
  key_id: string;
}

interface RotationSnapshotRow {
  snapshot_id: string;
  run_id: string;
  at_seq: number;
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
  readonly db: Database.Database;
  readonly codec: ContentCodec;
  readonly targetKeyId: string;
  readonly limit: number;
  readonly cursor: StoreRotationCursor | undefined;
}

function selectEvents(
  db: Database.Database,
  targetKeyId: string,
  after: number | undefined,
  limit: number,
): RotationEventRow[] {
  return db
    .prepare<[string, number | null, number | null, number], RotationEventRow>(
      `SELECT global_seq, run_id, seq, content_blob, key_id
        FROM events
        WHERE key_id IS NOT NULL AND key_id != ? AND (? IS NULL OR global_seq > ?)
        ORDER BY global_seq LIMIT ?`,
    )
    .all(targetKeyId, after ?? null, after ?? 0, limit);
}

function selectSnapshots(
  db: Database.Database,
  targetKeyId: string,
  after: string | undefined,
  limit: number,
): RotationSnapshotRow[] {
  return db
    .prepare<[string, string | null, string | null, number], RotationSnapshotRow>(
      `SELECT snapshot_id, run_id, at_seq, content_blob, key_id
        FROM snapshots
        WHERE key_id IS NOT NULL AND key_id != ? AND (? IS NULL OR snapshot_id > ?)
        ORDER BY snapshot_id LIMIT ?`,
    )
    .all(targetKeyId, after ?? null, after ?? null, limit);
}

async function encryptEvent(
  codec: ContentCodec,
  row: RotationEventRow,
  targetKeyId: string,
): Promise<RotationUpdate> {
  const runId = Id.parse(row.run_id);
  const context = { runId, seq: row.seq };
  const content = await codec.decode(context, row.content_blob, row.key_id);
  const encoded = await codec.encode(context, content, targetKeyId);
  if (encoded.keyId !== targetKeyId) {
    throw new ContentEncryptFailedError();
  }
  return {
    table: "events",
    globalSeq: row.global_seq,
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
  const context = { runId, seq: row.at_seq, purpose: "snapshot" as const };
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
  db,
  codec,
  targetKeyId,
  limit,
  cursor,
}: SelectBatchInput): Promise<SelectedBatch> {
  if (cursor?.table === "snapshots") {
    const rows = selectSnapshots(db, targetKeyId, cursor.after, limit + 1);
    const batch = rows.slice(0, limit);
    const last = batch.at(-1);
    return {
      updates: await encryptSnapshots(codec, batch, targetKeyId),
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: { table: "snapshots" as const, after: last.snapshot_id } }
        : {}),
    };
  }

  const eventRows = selectEvents(db, targetKeyId, cursor?.after, limit + 1);
  const eventBatch = eventRows.slice(0, limit);
  const eventUpdates = await encryptEvents(codec, eventBatch, targetKeyId);
  const lastEvent = eventBatch.at(-1);
  if (eventRows.length > limit && lastEvent !== undefined) {
    return {
      updates: eventUpdates,
      nextCursor: { table: "events", after: lastEvent.global_seq },
    };
  }

  const remaining = limit - eventBatch.length;
  const snapshotRows = selectSnapshots(db, targetKeyId, undefined, Math.max(1, remaining + 1));
  const snapshotBatch = snapshotRows.slice(0, remaining);
  const snapshotUpdates = await encryptSnapshots(codec, snapshotBatch, targetKeyId);
  let nextCursor: StoreRotationCursor | undefined;
  if (snapshotRows.length > remaining) {
    const lastSnapshot = snapshotBatch.at(-1);
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

function updateBatch(
  db: Database.Database,
  updates: readonly RotationUpdate[],
  targetKeyId: string,
): number {
  const updateEvent = db.prepare(
    "UPDATE events SET content_blob = ?, key_id = ? WHERE global_seq = ? AND key_id = ? AND content_blob = ?",
  );
  const updateSnapshot = db.prepare(
    "UPDATE snapshots SET content_blob = ?, key_id = ? WHERE snapshot_id = ? AND key_id = ? AND content_blob = ?",
  );
  const rotate = db.transaction(() =>
    updates.reduce((processed, row) => {
      const result =
        row.table === "events"
          ? updateEvent.run(row.blob, targetKeyId, row.globalSeq, row.oldKeyId, row.oldBlob)
          : updateSnapshot.run(row.blob, targetKeyId, row.snapshotId, row.oldKeyId, row.oldBlob);
      return processed + result.changes;
    }, 0),
  );
  return rotate.immediate();
}

/** Re-encrypt one bounded SQLite event/snapshot batch in a transaction. */
export async function reencryptSqliteBatch(
  db: Database.Database,
  codec: ContentCodec,
  input: ReencryptBatchInput,
): Promise<StoreReencryptBatchResult> {
  const { targetKeyId, limit, afterCursor } = ReencryptBatchInputSchema.parse(input);
  if (!codec.encrypted) {
    return StoreReencryptBatchResultSchema.parse({ processed: 0 });
  }
  try {
    const cursor = afterCursor === undefined ? undefined : decodeStoreRotationCursor(afterCursor);
    const selected = await selectBatch({ db, codec, targetKeyId, limit, cursor });
    const processed = updateBatch(db, selected.updates, targetKeyId);
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
      error instanceof KeyNotFoundError
    ) {
      throw error;
    }
    throw new StoreUnavailableError();
  }
}

/** Count encrypted event and snapshot rows grouped by key identifier. */
export function countSqliteRowsByKey(db: Database.Database): Promise<readonly StoreKeyRowCount[]> {
  try {
    const rows = db
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
