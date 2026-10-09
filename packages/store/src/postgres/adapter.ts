// SPDX-License-Identifier: Apache-2.0
import type { Event, Id, NewEvent } from "@harness/schemas";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { z } from "zod";
import { JsonContentCodec, type ContentCodec } from "../codec.js";
import { InvalidEventError } from "../errors.js";
import type { EventStore, ListRunsOptions, RunSummary } from "../types.js";
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
  type RunSummaryRow,
} from "./helpers.js";

const connectionStringSchema = z
  .url()
  .refine(
    (value) =>
      URL.canParse(value) && ["postgres:", "postgresql:"].includes(new URL(value).protocol),
  );
const optionsSchema = z
  .object({
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
  private initialized: Promise<void> | undefined;

  /**
   * Open a Postgres connection pool and initialize its event-store schema.
   *
   * @param connectionString Postgres connection URL.
   * @param options Pool size and schema selection.
   * @param codec Codec used to store content separately from event metadata.
   */
  constructor(
    connectionString: string,
    options: PostgresEventStoreOptions = {},
    codec: ContentCodec = new JsonContentCodec(),
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
        "SELECT to_regclass('runs') IS NOT NULL AND to_regclass('events') IS NOT NULL AND to_regclass('events_trace_id_idx') IS NOT NULL AND to_regclass('runs_status_created_at_idx') IS NOT NULL AS initialized",
      );
      if (schemaState.rows[0]?.initialized !== true) {
        await client.query(POSTGRES_SCHEMA);
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
    await this.ensureInitialized();
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw storeError(error, expectedSeq);
    }
    try {
      return { nextSeq: await appendTransaction(client, runId, encoded, expectedSeq) };
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
  schema?: string;
}): PostgresEventStore {
  const options: PostgresEventStoreOptions = {
    ...(args.poolSize === undefined ? {} : { poolSize: args.poolSize }),
    ...(args.schema === undefined ? {} : { schema: args.schema }),
  };
  return new PostgresEventStore(args.connectionString, options);
}
