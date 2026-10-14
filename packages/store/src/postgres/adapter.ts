// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  Id,
  TraceId,
  type Code as SinkId,
  type Event,
  type NewEvent,
  type Snapshot,
} from "@harness/schemas";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { z } from "zod";
import {
  JsonContentCodec,
  decodeSnapshot,
  encodeSnapshot,
  type ContentCodec,
  type EncodedSnapshot,
  type SnapshotRow,
  validateSnapshotAppend,
} from "../codec.js";
import {
  ContentDecryptFailedError,
  ContentEncryptFailedError,
  InvalidEventError,
  KeyNotFoundError,
  StoreReadOnlyError,
  StoreUnavailableError,
} from "../errors.js";
import {
  snapshotStoreOptionsSchema,
  systemClock,
  type Clock,
  type EventStore,
  type ListRunsOptions,
  type RunSummary,
} from "../types.js";
import { watchEvents, watchRunSummaries } from "../subscriptions.js";
import {
  appendTransaction,
  decodeCursor,
  encodeEvents,
  eventFromRow,
  integer,
  runListPage,
  storeError,
  type EventRow,
  type EncodedEvent,
  type RunSummaryRow,
} from "./helpers.js";
import { deleteRunTransaction } from "./retention.js";
import { PostgresApprovalNotifications } from "./approval-notifications.js";
import { PostgresConfirmationStates } from "./confirmation-states.js";
import { initializePostgresStore } from "./initialize.js";
import { readEvents } from "./reader.js";
import { isRunTerminal, PostgresSubscriptions } from "./subscriptions.js";
import {
  decodeStoreRotationCursor,
  encodeStoreRotationCursor,
  ReencryptBatchInputSchema,
  StoreKeyRowCountSchema,
  StoreReencryptBatchResultSchema,
  type ReencryptBatchInput,
  type StoreKeyRotation,
  type StoreRotationCursor,
} from "../rotate.js";

const connectionStringSchema = z
  .url()
  .refine(
    (value) =>
      URL.canParse(value) && ["postgres:", "postgresql:"].includes(new URL(value).protocol),
  );
const optionsSchema = snapshotStoreOptionsSchema
  .extend({
    poolSize: z.number().int().min(1).max(100).default(10),
    schema: z
      .string()
      .regex(/^[a-z_]\w{0,62}$/i)
      .default("public"),
    skipMigrations: z.boolean().default(false),
  })
  .strict();

interface PostgresRotationEventRow extends QueryResultRow {
  global_seq: number | string;
  run_id: string;
  seq: number | string;
  content_blob: string;
  key_id: string;
}

interface PostgresRotationSnapshotRow extends QueryResultRow {
  snapshot_id: string;
  run_id: string;
  at_seq: number | string;
  content_blob: string;
  key_id: string;
}

type PostgresRotationUpdate =
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

/** Options for a Postgres event-store connection. */
export type PostgresEventStoreOptions = z.input<typeof optionsSchema>;

/** Durable Postgres implementation of the append-only event store. */
export class PostgresEventStore implements EventStore, StoreKeyRotation {
  private readonly pool: Pool;
  private readonly codec: ContentCodec;
  private readonly snapshotKeep: number;
  private readonly clock: Clock;
  private readonly skipMigrations: boolean;
  private readonly approvalNotifications: PostgresApprovalNotifications;
  private readonly confirmationStates: PostgresConfirmationStates;
  private readonly subscriptions: PostgresSubscriptions;
  private initialized: Promise<void> | undefined;

  /**
   * Open a Postgres connection pool and initialize its event-store schema.
   *
   * @param connectionString Postgres connection URL.
   * @param options Pool size, schema selection, and validation-only read-only mode.
   * @param codec Codec used to store content separately from event metadata.
   * @param clock Clock supplying timestamps for sink-cursor updates.
   */
  constructor(
    connectionString: string,
    options: PostgresEventStoreOptions = {},
    codec: ContentCodec = new JsonContentCodec(),
    clock: Clock = systemClock,
  ) {
    const parsedConnectionString = connectionStringSchema.safeParse(connectionString);
    const parsedOptions = optionsSchema.safeParse(options);
    if (!parsedConnectionString.success || !parsedOptions.success) {
      throw new TypeError("Invalid Postgres event-store configuration");
    }
    this.pool = new Pool({
      connectionString: parsedConnectionString.data,
      max: parsedOptions.data.poolSize,
      options: `-c search_path="${parsedOptions.data.schema}"`,
    });
    this.pool.on("error", () => undefined);
    this.codec = codec;
    this.snapshotKeep = parsedOptions.data.snapshotKeep;
    this.clock = clock;
    this.skipMigrations = parsedOptions.data.skipMigrations;
    this.approvalNotifications = new PostgresApprovalNotifications(this.pool, () =>
      this.ensureInitialized(),
    );
    this.confirmationStates = new PostgresConfirmationStates(this.pool, () =>
      this.ensureInitialized(),
    );
    this.subscriptions = new PostgresSubscriptions(
      this.pool,
      parsedConnectionString.data,
      parsedOptions.data.schema,
      () => this.ensureInitialized(),
    );
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize().catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private assertWritable(): void {
    if (this.skipMigrations) {
      throw new StoreReadOnlyError();
    }
  }

  private async initialize(): Promise<void> {
    await initializePostgresStore(this.pool, this.codec, this.clock, this.skipMigrations);
  }

  /** {@inheritDoc StoreKeyRotation.reencryptBatch} */
  async reencryptBatch(input: ReencryptBatchInput) {
    this.assertWritable();
    const { targetKeyId, limit, afterCursor } = ReencryptBatchInputSchema.parse(input);
    if (!this.codec.encrypted) {
      return StoreReencryptBatchResultSchema.parse({ processed: 0 });
    }
    await this.ensureInitialized();
    const cursor = afterCursor === undefined ? undefined : decodeStoreRotationCursor(afterCursor);
    const selected: PostgresRotationUpdate[] = [];
    let nextCursor: StoreRotationCursor | undefined;

    try {
      if (cursor?.table !== "snapshots") {
        const events = await this.pool.query<PostgresRotationEventRow>(
          `SELECT global_seq, run_id, seq, content_blob, key_id
           FROM events
           WHERE key_id IS NOT NULL AND key_id <> $1
             AND ($2::bigint IS NULL OR global_seq > $2::bigint)
           ORDER BY global_seq LIMIT $3`,
          [targetKeyId, cursor?.after ?? null, limit + 1],
        );
        const eventBatch = events.rows.slice(0, limit);
        for (const row of eventBatch) {
          const runId = Id.parse(row.run_id);
          const seq = integer(row.seq);
          const context = { runId, seq };
          const content = await this.codec.decode(context, row.content_blob, row.key_id);
          const encoded = await this.codec.encode(context, content, targetKeyId);
          if (encoded.keyId !== targetKeyId) {
            throw new ContentEncryptFailedError();
          }
          selected.push({
            table: "events",
            globalSeq: integer(row.global_seq),
            blob: encoded.blob,
            oldBlob: row.content_blob,
            oldKeyId: row.key_id,
          });
        }
        if (events.rows.length > limit) {
          const last = eventBatch.at(-1);
          if (last !== undefined) {
            nextCursor = { table: "events", after: integer(last.global_seq) };
          }
        } else {
          const remaining = limit - eventBatch.length;
          const snapshots = await this.pool.query<PostgresRotationSnapshotRow>(
            `SELECT snapshot_id, run_id, at_seq, content_blob, key_id
             FROM snapshots
             WHERE key_id IS NOT NULL AND key_id <> $1
             ORDER BY snapshot_id LIMIT $2`,
            [targetKeyId, Math.max(1, remaining + 1)],
          );
          const snapshotBatch = snapshots.rows.slice(0, remaining);
          for (const row of snapshotBatch) {
            const runId = Id.parse(row.run_id);
            const context = { runId, seq: integer(row.at_seq), purpose: "snapshot" as const };
            const content = await this.codec.decode(context, row.content_blob, row.key_id);
            const encoded = await this.codec.encode(context, content, targetKeyId);
            if (encoded.keyId !== targetKeyId) {
              throw new ContentEncryptFailedError();
            }
            selected.push({
              table: "snapshots",
              snapshotId: row.snapshot_id,
              blob: encoded.blob,
              oldBlob: row.content_blob,
              oldKeyId: row.key_id,
            });
          }
          if (snapshots.rows.length > remaining) {
            const last = snapshotBatch.at(-1);
            nextCursor =
              last === undefined
                ? { table: "snapshots" }
                : { table: "snapshots", after: last.snapshot_id };
          }
        }
      } else {
        const snapshots = await this.pool.query<PostgresRotationSnapshotRow>(
          `SELECT snapshot_id, run_id, at_seq, content_blob, key_id
           FROM snapshots
           WHERE key_id IS NOT NULL AND key_id <> $1 AND ($2::text IS NULL OR snapshot_id > $2)
           ORDER BY snapshot_id LIMIT $3`,
          [targetKeyId, cursor.after ?? null, limit + 1],
        );
        const snapshotBatch = snapshots.rows.slice(0, limit);
        for (const row of snapshotBatch) {
          const runId = Id.parse(row.run_id);
          const context = { runId, seq: integer(row.at_seq), purpose: "snapshot" as const };
          const content = await this.codec.decode(context, row.content_blob, row.key_id);
          const encoded = await this.codec.encode(context, content, targetKeyId);
          if (encoded.keyId !== targetKeyId) {
            throw new ContentEncryptFailedError();
          }
          selected.push({
            table: "snapshots",
            snapshotId: row.snapshot_id,
            blob: encoded.blob,
            oldBlob: row.content_blob,
            oldKeyId: row.key_id,
          });
        }
        if (snapshots.rows.length > limit) {
          const last = snapshotBatch.at(-1);
          if (last !== undefined) {
            nextCursor = { table: "snapshots", after: last.snapshot_id };
          }
        }
      }

      const client = await this.pool.connect();
      let processed = 0;
      try {
        await client.query("BEGIN");
        for (const row of selected) {
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
      } catch {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new StoreUnavailableError();
      } finally {
        client.release();
      }
      return StoreReencryptBatchResultSchema.parse({
        processed,
        ...(nextCursor === undefined
          ? {}
          : { nextCursor: encodeStoreRotationCursor(nextCursor) }),
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
  async countRowsByKey(): Promise<readonly { keyId: string; count: number }[]> {
    await this.ensureInitialized();
    try {
      const result = await this.pool.query<{ key_id: string; count: number | string }>(
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

  /** {@inheritDoc EventStore.append} */
  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
  ): Promise<{ nextSeq: number }> {
    this.assertWritable();
    const encoded = await encodeEvents(this.codec, runId, events, expectedSeq);
    return this.appendEncoded(runId, encoded, expectedSeq);
  }

  /** {@inheritDoc EventStore.appendWithSnapshot} */
  async appendWithSnapshot(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Snapshot,
  ): Promise<{ nextSeq: number }> {
    this.assertWritable();
    const validatedSnapshot = validateSnapshotAppend(runId, events, expectedSeq, snapshot);
    const [encoded, encodedSnapshot] = await Promise.all([
      encodeEvents(this.codec, runId, events, expectedSeq),
      encodeSnapshot(this.codec, validatedSnapshot),
    ]);
    return this.appendEncoded(runId, encoded, expectedSeq, encodedSnapshot);
  }

  private async appendEncoded(
    runId: Id,
    encoded: readonly EncodedEvent[],
    expectedSeq: number,
    encodedSnapshot?: EncodedSnapshot,
  ): Promise<{ nextSeq: number }> {
    await this.ensureInitialized();
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw storeError(error, expectedSeq);
    }
    try {
      return {
        nextSeq: await appendTransaction(client, {
          runId,
          encoded,
          expectedSeq,
          ...(encodedSnapshot === undefined ? {} : { encodedSnapshot }),
          snapshotKeep: this.snapshotKeep,
        }),
      };
    } finally {
      client.release();
    }
  }

  /** {@inheritDoc EventStore.read} */
  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<Event> {
    return readEvents(
      { pool: this.pool, codec: this.codec, ensureInitialized: () => this.ensureInitialized() },
      runId,
      range,
    );
  }

  /** {@inheritDoc EventStore.watch} */
  watch(runId: Id, options: Parameters<EventStore["watch"]>[1]): AsyncIterable<Event> {
    return watchEvents(this, runId, options, {
      subscribe: (watchedRunId, signal) => this.subscriptions.subscribe(watchedRunId, signal),
      isTerminal: (watchedRunId, observedNextSeq) =>
        isRunTerminal(this.pool, () => this.ensureInitialized(), watchedRunId, observedNextSeq),
    });
  }

  /** {@inheritDoc EventStore.watchRuns} */
  watchRuns(options: Parameters<EventStore["watchRuns"]>[0]): AsyncIterable<RunSummary> {
    return watchRunSummaries(
      this,
      options,
      (runId, signal) => this.subscriptions.subscribe(runId, signal),
      async (runId) => {
        try {
          await this.ensureInitialized();
          const result = await this.pool.query<RunSummaryRow>(
            "SELECT run_id, created_at, status, next_seq - 1 AS last_seq, last_ts FROM runs WHERE run_id = $1",
            [runId],
          );
          const row = result.rows[0];
          return row === undefined ? undefined : runListPage([row], 1).runs[0];
        } catch (error) {
          throw storeError(error);
        }
      },
    );
  }

  /** {@inheritDoc EventStore.head} */
  async head(runId: Id): Promise<number> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<{ next_seq: number | string }>(
        "SELECT next_seq FROM runs WHERE run_id = $1",
        [runId],
      );
      const row = result.rows[0];
      return row === undefined ? 0 : integer(row.next_seq);
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.deleteRun} */
  async deleteRun(runId: Id): Promise<number> {
    this.assertWritable();
    try {
      await this.ensureInitialized();
      const client = await this.pool.connect();
      try {
        return await deleteRunTransaction(client, runId);
      } finally {
        client.release();
      }
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.latestSnapshot} */
  async latestSnapshot(runId: Id): Promise<Snapshot | undefined> {
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<SnapshotRow & QueryResultRow>(
        "SELECT snapshot_id, run_id, at_seq, created_at, meta_json, content_blob, key_id FROM snapshots WHERE run_id = $1 ORDER BY at_seq DESC, snapshot_id DESC LIMIT 1",
        [runId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : await decodeSnapshot(this.codec, row);
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.listRuns} */
  async listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new InvalidEventError([["limit"]]);
    }
    try {
      await this.ensureInitialized();
      const cursor = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor);
      const result = await this.pool.query<RunSummaryRow>(
        `SELECT runs.run_id, runs.created_at, runs.status, runs.next_seq - 1 AS last_seq, runs.last_ts
        FROM runs
        WHERE ($1::text IS NULL OR runs.run_id IN (
          SELECT run_id FROM events
          WHERE type = 'run_created' AND meta ->> 'continuationOf' = $1
        ))
        AND ($2::text IS NULL OR runs.status = $2)
        AND ($3::bigint IS NULL OR runs.created_at < $3 OR (runs.created_at = $3 AND runs.run_id > $4))
        ORDER BY runs.created_at DESC, runs.run_id ASC
        LIMIT $5`,
        [
          opts.continuationOf ?? null,
          opts.status ?? null,
          cursor?.createdAt ?? null,
          cursor?.runId ?? null,
          opts.limit + 1,
        ],
      );
      return runListPage(result.rows, opts.limit);
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.findRunsByTrace} */
  async findRunsByTrace(traceId: TraceId): Promise<Id[]> {
    const parsedTraceId = TraceId.safeParse(traceId);
    if (!parsedTraceId.success) {
      throw new InvalidEventError([["traceId"]]);
    }
    try {
      await this.ensureInitialized();
      const result = await this.pool.query<{ run_id: string }>(
        "SELECT run_id FROM events WHERE trace_id = $1 GROUP BY run_id ORDER BY MIN(global_seq)",
        [parsedTraceId.data],
      );
      return result.rows.map(({ run_id }) => Id.parse(run_id));
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.fetchOutbox} */
  async fetchOutbox(sinkId: SinkId, limit: number): Promise<{ events: Event[]; cursor: number }> {
    const parsedSinkId = Code.safeParse(sinkId);
    if (!parsedSinkId.success) {
      throw new InvalidEventError([["sinkId"]]);
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new InvalidEventError([["limit"]]);
    }
    try {
      await this.ensureInitialized();
      const cursorResult = await this.pool.query<{ cursor: number | string }>(
        "SELECT cursor FROM sink_cursors WHERE sink_id = $1",
        [parsedSinkId.data],
      );
      const lastAcked =
        cursorResult.rows[0] === undefined ? 0 : integer(cursorResult.rows[0].cursor);
      const result = await this.pool.query<EventRow & { global_seq: number | string }>(
        "SELECT global_seq, run_id, seq, ts, type, trace_id, span_id, segment_id, meta, content_blob, key_id FROM events WHERE global_seq > $1 AND tx_id < pg_snapshot_xmin(pg_current_snapshot()) ORDER BY global_seq LIMIT $2",
        [lastAcked, limit],
      );
      const events: Event[] = [];
      for (const row of result.rows) {
        const runId = Id.safeParse(row.run_id);
        if (!runId.success) {
          throw new StoreUnavailableError();
        }
        events.push(await eventFromRow(this.codec, runId.data, row));
      }
      const last = result.rows.at(-1);
      return {
        events,
        cursor: last === undefined ? lastAcked : integer(last.global_seq),
      };
    } catch (error) {
      throw storeError(error);
    }
  }

  /** {@inheritDoc EventStore.ackOutbox} */
  async ackOutbox(sinkId: SinkId, cursor: number): Promise<void> {
    const parsedSinkId = Code.safeParse(sinkId);
    if (!parsedSinkId.success) {
      throw new InvalidEventError([["sinkId"]]);
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new InvalidEventError([["cursor"]]);
    }
    this.assertWritable();
    try {
      await this.ensureInitialized();
      await this.pool.query(
        "INSERT INTO sink_cursors (sink_id, cursor, updated_at) VALUES ($1, $2, $3) ON CONFLICT (sink_id) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at WHERE sink_cursors.cursor < EXCLUDED.cursor",
        [parsedSinkId.data, cursor, this.clock.now()],
      );
    } catch (error) {
      throw storeError(error);
    }
  }

  async claimApprovalNotification(
    ...args: Parameters<EventStore["claimApprovalNotification"]>
  ): ReturnType<EventStore["claimApprovalNotification"]> {
    this.assertWritable();
    return this.approvalNotifications.claim(...args);
  }

  async markApprovalNotificationSent(
    ...args: Parameters<EventStore["markApprovalNotificationSent"]>
  ): ReturnType<EventStore["markApprovalNotificationSent"]> {
    this.assertWritable();
    return this.approvalNotifications.markSent(...args);
  }

  async releaseApprovalNotification(
    ...args: Parameters<EventStore["releaseApprovalNotification"]>
  ): ReturnType<EventStore["releaseApprovalNotification"]> {
    this.assertWritable();
    return this.approvalNotifications.release(...args);
  }

  /** {@inheritDoc EventStore.consumeConfirmationState} */
  consumeConfirmationState(
    ...args: Parameters<EventStore["consumeConfirmationState"]>
  ): ReturnType<EventStore["consumeConfirmationState"]> {
    this.assertWritable();
    return this.confirmationStates.consume(...args);
  }

  /** {@inheritDoc EventStore.close} */
  async close(): Promise<void> {
    try {
      await this.subscriptions.close();
      await this.pool.end();
    } catch (error) {
      throw storeError(error);
    }
  }
}

/** Open a Postgres event store from the JSON arguments supplied to a worker thread. */
export function openPostgresEventStore(args: {
  connectionString: string;
  poolSize?: number;
  snapshotKeep?: number;
  schema?: string;
}): PostgresEventStore {
  const options: PostgresEventStoreOptions = {
    ...(args.poolSize === undefined ? {} : { poolSize: args.poolSize }),
    ...(args.snapshotKeep === undefined ? {} : { snapshotKeep: args.snapshotKeep }),
    ...(args.schema === undefined ? {} : { schema: args.schema }),
  };
  return new PostgresEventStore(args.connectionString, options);
}
