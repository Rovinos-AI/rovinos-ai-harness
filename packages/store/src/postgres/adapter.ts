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
  InvalidEventError,
  StoreEncryptionMismatchError,
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
import {
  appendTransaction,
  decodeCursor,
  encodeEvents,
  eventFromRow,
  integer,
  POSTGRES_SCHEMA,
  READ_PAGE_SIZE,
  runListPage,
  storeError,
  type EventRow,
  type EncodedEvent,
  type RunSummaryRow,
} from "./helpers.js";

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
  })
  .strict();

/** Options for a Postgres event-store connection. */
export type PostgresEventStoreOptions = z.input<typeof optionsSchema>;

/** Durable Postgres implementation of the append-only event store. */
export class PostgresEventStore implements EventStore {
  private readonly pool: Pool;
  private readonly codec: ContentCodec;
  private readonly snapshotKeep: number;
  private readonly clock: Clock;
  private initialized: Promise<void> | undefined;

  /**
   * Open a Postgres connection pool and initialize its event-store schema.
   *
   * @param connectionString Postgres connection URL.
   * @param options Pool size and schema selection.
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
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize().catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw storeError(error);
    }
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema())::bigint)");
      const schemaState = await client.query<{ initialized: boolean } & QueryResultRow>(
        "SELECT to_regclass('runs') IS NOT NULL AND to_regclass('events') IS NOT NULL AND to_regclass('events_trace_id_idx') IS NOT NULL AND to_regclass('runs_status_created_at_idx') IS NOT NULL AND to_regclass('snapshots') IS NOT NULL AND to_regclass('snapshots_run_at_seq_idx') IS NOT NULL AND to_regclass('sink_cursors') IS NOT NULL AND to_regclass('store_metadata') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = 'tx_id') AS initialized",
      );
      if (schemaState.rows[0]?.initialized !== true) {
        await client.query(POSTGRES_SCHEMA);
      }
      const encryptionState = await client.query<{ metadata_value: string } & QueryResultRow>(
        "SELECT metadata_value FROM store_metadata WHERE metadata_key = $1",
        ["encrypted"],
      );
      const expectedEncryption = this.codec.encrypted ? "true" : "false";
      const storedEncryption = encryptionState.rows[0]?.metadata_value;
      if (storedEncryption === undefined) {
        const contentCount = await client.query<{ count: string } & QueryResultRow>(
          "SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM snapshots) AS count",
        );
        if (expectedEncryption === "true" && Number(contentCount.rows[0]?.count ?? "0") !== 0) {
          throw new StoreEncryptionMismatchError();
        }
        await client.query(
          "INSERT INTO store_metadata (metadata_key, metadata_value) VALUES ($1, $2) ON CONFLICT (metadata_key) DO NOTHING",
          ["encrypted", expectedEncryption],
        );
      } else if (storedEncryption !== expectedEncryption) {
        throw new StoreEncryptionMismatchError();
      }
      await client.query("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw storeError(error);
    } finally {
      client.release();
    }
  }

  /** {@inheritDoc EventStore.append} */
  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
  ): Promise<{ nextSeq: number }> {
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
  async *read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<Event> {
    const toSeq = range?.toSeq ?? null;
    let nextSeq = range?.fromSeq ?? 0;
    try {
      await this.ensureInitialized();
      let rows = (
        await this.pool.query<EventRow>(
          "SELECT run_id, seq, ts, type, trace_id, span_id, segment_id, meta, content_blob, key_id FROM events WHERE run_id = $1 AND seq >= $2 AND ($3::bigint IS NULL OR seq <= $3) ORDER BY seq LIMIT $4",
          [runId, nextSeq, toSeq, READ_PAGE_SIZE],
        )
      ).rows;
      while (rows.length !== 0) {
        for (const row of rows) {
          yield await eventFromRow(this.codec, runId, row);
          nextSeq = integer(row.seq) + 1;
        }
        rows = (
          await this.pool.query<EventRow>(
            "SELECT run_id, seq, ts, type, trace_id, span_id, segment_id, meta, content_blob, key_id FROM events WHERE run_id = $1 AND seq >= $2 AND ($3::bigint IS NULL OR seq <= $3) ORDER BY seq LIMIT $4",
            [runId, nextSeq, toSeq, READ_PAGE_SIZE],
          )
        ).rows;
      }
    } catch (error) {
      throw storeError(error);
    }
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
        WHERE ($1::text IS NULL OR runs.status = $1)
        AND ($2::bigint IS NULL OR runs.created_at < $2 OR (runs.created_at = $2 AND runs.run_id > $3))
        ORDER BY runs.created_at DESC, runs.run_id ASC
        LIMIT $4`,
        [opts.status ?? null, cursor?.createdAt ?? null, cursor?.runId ?? null, opts.limit + 1],
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

  /** {@inheritDoc EventStore.close} */
  async close(): Promise<void> {
    try {
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
