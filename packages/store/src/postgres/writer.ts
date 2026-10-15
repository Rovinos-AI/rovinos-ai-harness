// SPDX-License-Identifier: Apache-2.0
import type { Pool, PoolClient } from "pg";
import type { Id, NewEvent, Snapshot } from "@harness/schemas";
import type { ContentCodec, EncodedSnapshot } from "../codec.js";
import { encodeSnapshot, validateSnapshotAppend } from "../codec.js";
import { appendTransaction, encodeEvents, storeError, type EncodedEvent } from "./helpers.js";

/** Dependencies used by a Postgres event writer. */
export interface PostgresEventWriterOptions {
  readonly pool: Pool;
  readonly codec: ContentCodec;
  readonly ensureInitialized: () => Promise<void>;
  readonly assertWritable: () => void;
  readonly snapshotKeep: number;
}

/** Append and snapshot operations for a Postgres event store. */
export class PostgresEventWriter {
  private readonly pool: Pool;
  private readonly codec: ContentCodec;
  private readonly ensureInitialized: () => Promise<void>;
  private readonly assertWritable: () => void;
  private readonly snapshotKeep: number;

  constructor(options: PostgresEventWriterOptions) {
    this.pool = options.pool;
    this.codec = options.codec;
    this.ensureInitialized = options.ensureInitialized;
    this.assertWritable = options.assertWritable;
    this.snapshotKeep = options.snapshotKeep;
  }

  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
  ): Promise<{ nextSeq: number }> {
    this.assertWritable();
    const encoded = await encodeEvents(this.codec, runId, events, expectedSeq);
    return this.appendEncoded(runId, encoded, expectedSeq);
  }

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
}
